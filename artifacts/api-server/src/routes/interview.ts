/**
 * interview routes — Jack Interview Mode.
 *
 * A conversational flow where an experienced tradesperson is interviewed by Jack
 * one question at a time. Every answer is stored VERBATIM, distilled into
 * candidate atomic knowledge (best-effort — a distillation failure never loses the
 * answer), and mirrored into the SAME shared knowledge graph as mentor-sourced
 * corroboration. The server is authoritative for the pending question; the session
 * id is an unguessable UUID (no cross-session state is exposed).
 *
 * These endpoints call paid models (next-question generation + distillation) and
 * are therefore rate-limited. Like the rest of the API they run under the Supabase
 * service-role key, so they never accept caller-supplied privileged identifiers.
 */
import { Router } from "express";
import multer from "multer";
import { supabase } from "../lib/supabase.js";
import {
  ListMentorsResponse,
  PreviewMentorWithdrawalParams,
  PreviewMentorWithdrawalResponse,
  StartInterviewBody,
  SubmitInterviewAnswerBody,
  WithdrawMentorParams,
  WithdrawMentorResponse,
} from "@workspace/api-zod";
import { requireAdmin } from "../lib/admin-auth.js";
import { publish } from "../lib/vitality.js";
import {
  previewMentorWithdrawal,
  withdrawMentor,
  verifyAndRecordGraphWrite,
} from "../lib/memory-graph.js";
import { aiInterviewLimiter } from "../lib/rate-limit.js";
import {
  generateNextQuestion,
  normalizeTrade,
  type AnsweredTurn,
  type MentorProfileLite,
} from "../lib/interview.js";
import { runMentorAnswerDistillation, type MentorDistilledItem } from "../lib/distillation.js";
import { transcribeAudioBuffer } from "../lib/transcription.js";

const router = Router();

const MAX_ANSWER_LENGTH = 8000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whisper's hard upload limit is 25 MB. A mono voice recording is tiny (~1 MB /
 * minute), so this cap comfortably covers even a very long spoken answer while
 * bounding the RAM a single request can buffer (memoryStorage) and the OpenAI
 * spend it can trigger. Paired with aiInterviewLimiter + an active-session gate.
 */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/**
 * MIME types a browser MediaRecorder realistically emits for audio. Chrome/
 * Firefox produce webm/opus (sometimes mislabeled `video/webm` for an
 * audio-only stream), iOS Safari produces mp4/aac; ogg/wav/mpeg are included
 * for completeness. Anything else is rejected before it reaches Whisper.
 */
const AUDIO_MIME_ALLOWLIST = new Set([
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "video/webm",
  "video/mp4",
]);

/** Map a recorded MIME type to the file extension Whisper uses to detect format. */
function audioExtension(mimetype: string): string {
  const mime = mimetype.split(";")[0]?.trim().toLowerCase() ?? "";
  switch (mime) {
    case "audio/ogg":
      return "ogg";
    case "audio/mp4":
    case "video/mp4":
      return "mp4";
    case "audio/mpeg":
      return "mp3";
    case "audio/wav":
    case "audio/x-wav":
      return "wav";
    case "audio/webm":
    case "video/webm":
    default:
      return "webm";
  }
}

/**
 * multipart parser for the single "audio" field of a voice answer. In-memory
 * (clips are small and never persisted), size-capped, and MIME-allowlisted.
 */
const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AUDIO_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const mime = file.mimetype.split(";")[0]?.trim().toLowerCase() ?? "";
    cb(null, AUDIO_MIME_ALLOWLIST.has(mime));
  },
}).single("audio");

type Row = Record<string, unknown>;

/** Shape a session row (+ mentor name) into the API InterviewSession response. */
function serializeSession(session: Row, mentorName: string): Record<string, unknown> {
  const status = (session["status"] as string) ?? "active";
  return {
    id: session["id"],
    mentorProfileId: session["mentor_profile_id"],
    mentorName,
    trade: (session["trade"] as string | null) ?? null,
    status,
    currentQuestion: (session["current_question"] as string | null) ?? null,
    currentCategory: (session["current_category"] as string | null) ?? null,
    currentTopic: (session["current_topic"] as string | null) ?? null,
    questionCount: (session["question_count"] as number) ?? 0,
    complete: status === "completed",
    createdAt: session["created_at"],
  };
}

/** Shape an answer row into the API InterviewAnswer response. */
function serializeAnswer(answer: Row): Record<string, unknown> {
  const snapshot = answer["extracted_knowledge"];
  return {
    id: answer["id"],
    question: answer["question"],
    category: (answer["category"] as string | null) ?? null,
    topic: (answer["topic"] as string | null) ?? null,
    answerText: (answer["answer_text"] as string | null) ?? null,
    skipped: Boolean(answer["skipped"]),
    distillationStatus: (answer["distillation_status"] as string | null) ?? "pending",
    extractedKnowledge: Array.isArray(snapshot) ? snapshot : [],
    createdAt: answer["created_at"],
  };
}

/** Snapshot distilled knowledge for the answer row + the API response. */
function serializeKnowledge(items: MentorDistilledItem[]): Array<Record<string, unknown>> {
  return items.map((k) => ({
    id: k.id,
    title: k.title,
    description: k.description,
    category: k.category,
    confidence: k.confidence,
    competencyCode: k.competencyCode,
    outcome: k.outcome,
    matchedLabel: k.matchedLabel,
  }));
}

/** Load a mentor profile as the lite shape the question engine consumes. */
function toProfileLite(mentor: Row): MentorProfileLite {
  const trade = (mentor["trade"] as string | null) ?? null;
  const tradeInput = (mentor["trade_input"] as string | null) ?? null;
  return {
    name: (mentor["name"] as string) ?? "the mentor",
    trade,
    tradeLabel: tradeInput || trade,
    yearsExperience: (mentor["years_experience"] as number | null) ?? null,
    specialties: Array.isArray(mentor["specialties"]) ? (mentor["specialties"] as string[]) : [],
    region: (mentor["region"] as string | null) ?? null,
    background: (mentor["background"] as string | null) ?? null,
  };
}

/** Build the ordered conversation history for the question engine. */
async function loadHistory(sessionId: string): Promise<AnsweredTurn[]> {
  const { data, error } = await supabase
    .from("interview_answers")
    .select("question, category, topic, answer_text, skipped, created_at")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((a: Row) => ({
    question: (a["question"] as string) ?? "",
    category: (a["category"] as string | null) ?? null,
    topic: (a["topic"] as string | null) ?? null,
    answer: (a["answer_text"] as string | null) ?? null,
    skipped: Boolean(a["skipped"]),
  }));
}

/** Fetch a session and its mentor only when both belong to the signed-in contributor. */
async function loadSession(
  rawId: string | string[] | undefined,
  ownerUserId: string | undefined,
): Promise<{ session: Row; mentor: Row } | null> {
  const id = String(rawId ?? "");
  if (!UUID_RE.test(id) || !ownerUserId) return null;
  const { data: session, error } = await supabase
    .from("interview_sessions")
    .select("*")
    .eq("id", id)
    .eq("contributor_user_id", ownerUserId)
    .maybeSingle();
  if (error) throw error;
  if (!session) return null;

  const { data: mentor, error: mErr } = await supabase
    .from("mentor_profiles")
    .select("*")
    .eq("id", session["mentor_profile_id"])
    .maybeSingle();
  if (mErr) throw mErr;
  if (!mentor) return null;
  // Personal interviews do not have an admin bypass. The contributor owns both
  // the session and the mentor profile; stale ids or cross-account resume
  // attempts must fail closed.
  if (mentor["contributor_user_id"] !== ownerUserId) return null;
  return { session: session as Row, mentor: mentor as Row };
}

router.post("/interview/sessions", aiInterviewLimiter, async (req, res) => {
  try {
    const ownerUserId = req.userId;
    if (!ownerUserId) return res.status(401).json({ error: "Unauthorized — sign in required." });

    const parsed = StartInterviewBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const body = parsed.data;

    const trade = normalizeTrade(body.trade, body.tradeInput ?? null);
    const tradeInput = body.trade === "Other" ? (body.tradeInput ?? null) : body.trade;

    const { data: mentor, error: mErr } = await supabase
      .from("mentor_profiles")
      .insert({
        name: body.name,
        trade,
        trade_input: tradeInput,
        years_experience: body.yearsExperience ?? null,
        specialties: body.specialties ?? [],
        region: body.region ?? null,
        background: body.background ?? null,
        contributor_user_id: ownerUserId,
      })
      .select("*")
      .single();
    if (mErr) throw mErr;

    const profile = toProfileLite(mentor as Row);
    const next = await generateNextQuestion(profile, []);
    const completed = next.complete || !next.question;

    const { data: session, error: sErr } = await supabase
      .from("interview_sessions")
      .insert({
        mentor_profile_id: (mentor as Row)["id"],
        contributor_user_id: ownerUserId,
        trade,
        status: completed ? "completed" : "active",
        current_question: completed ? null : next.question,
        current_category: completed ? null : next.category,
        current_topic: completed ? null : next.topic,
        asked_categories: completed ? [] : [next.category],
        question_count: completed ? 0 : 1,
        completed_at: completed ? new Date().toISOString() : null,
      })
      .select("*")
      .single();
    if (sErr) throw sErr;

    return res.status(201).json(serializeSession(session as Row, profile.name));
  } catch (err) {
    req.log.error({ err }, "startInterview error");
    return res.status(500).json({ error: "Failed to start interview" });
  }
});

router.get("/interview/sessions/:id", async (req, res) => {
  try {
    const loaded = await loadSession(req.params.id, req.userId);
    if (!loaded) return res.status(404).json({ error: "Interview session not found" });

    // Return the ordered prior answers alongside the session so the client can
    // rebuild the running transcript and resume an interrupted interview.
    const { data: answers, error: aErr } = await supabase
      .from("interview_answers")
      .select("*")
      .eq("session_id", loaded.session["id"])
      .order("created_at", { ascending: true });
    if (aErr) throw aErr;

    return res.json({
      session: serializeSession(loaded.session, loaded.mentor["name"] as string),
      answers: (answers ?? []).map((a: Row) => serializeAnswer(a)),
    });
  } catch (err) {
    req.log.error({ err }, "getInterviewSession error");
    return res.status(500).json({ error: "Failed to load interview session" });
  }
});

/**
 * The signed-in contributor's in-progress interview session for a mentor, if
 * any — powers "Resume Interview" on their node in the Living Memory graph.
 * Admins do not get a bypass here: the owner is the authenticated contributor
 * who created the interview, not a client-supplied or admin-forged identity.
 * Returns `{}` (not 404) when there is nothing to resume, so the client hook
 * stays on its success path.
 */
router.get("/interview/mentors/:id/active-session", async (req, res) => {
  try {
    const ownerUserId = req.userId;
    if (!ownerUserId) return res.status(401).json({ error: "Unauthorized — sign in required." });

    const id = String(req.params.id ?? "");
    if (!UUID_RE.test(id)) return res.json({});

    const { data: session, error } = await supabase
      .from("interview_sessions")
      .select("*")
      .eq("mentor_profile_id", id)
      .eq("contributor_user_id", ownerUserId)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!session) return res.json({});

    const { data: mentor, error: mErr } = await supabase
      .from("mentor_profiles")
      .select("name, contributor_user_id")
      .eq("id", id)
      .maybeSingle();
    if (mErr) throw mErr;
    if (!mentor) return res.json({});
    if ((mentor as Row)["contributor_user_id"] !== ownerUserId) return res.json({});

    return res.json({
      session: serializeSession(session as Row, (mentor as Row)["name"] as string),
    });
  } catch (err) {
    req.log.error({ err }, "getMentorActiveSession error");
    return res.status(500).json({ error: "Failed to load mentor session" });
  }
});

router.post("/interview/sessions/:id/answers", aiInterviewLimiter, async (req, res) => {
  try {
    const parsed = SubmitInterviewAnswerBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

    const answerText = parsed.data.answer;
    if (answerText.length > MAX_ANSWER_LENGTH) {
      return res
        .status(400)
        .json({ error: `Answer must be ${MAX_ANSWER_LENGTH} characters or fewer.` });
    }

    const loaded = await loadSession(req.params.id, req.userId);
    if (!loaded) return res.status(404).json({ error: "Interview session not found" });
    const { session, mentor } = loaded;

    if ((session["status"] as string) === "completed") {
      return res.status(409).json({ error: "This interview is already complete." });
    }
    const question = session["current_question"] as string | null;
    if (!question) {
      return res.status(409).json({ error: "There is no pending question to answer." });
    }

    // Persist the verbatim answer FIRST so a downstream distillation failure never
    // loses what the mentor said. Stored raw (React escapes on render).
    const { data: answer, error: aErr } = await supabase
      .from("interview_answers")
      .insert({
        session_id: session["id"],
        mentor_profile_id: session["mentor_profile_id"],
        question,
        category: (session["current_category"] as string | null) ?? null,
        topic: (session["current_topic"] as string | null) ?? null,
        answer_text: answerText,
        skipped: false,
      })
      .select("*")
      .single();
    if (aErr) throw aErr;
    const answerRow = answer as Row;

    // Distill into the shared graph, then VERIFY the knowledge actually landed.
    // The verbatim answer is already saved, so a distillation/verification failure
    // never loses it — instead we FLAG the answer (distillation_status='failed')
    // so it surfaces on the admin Graph Health dashboard and can be redistilled,
    // rather than silently reporting success.
    let extracted: MentorDistilledItem[] = [];
    let distillationStatus = "verified";
    let distillationError: string | null = null;
    const startedAtMs = Date.now();
    publish({ type: "memory:write:start" });
    try {
      const result = await runMentorAnswerDistillation({
        mentorProfileId: session["mentor_profile_id"] as string,
        mentorName: mentor["name"] as string,
        answerId: answerRow["id"] as string,
        sessionId: session["id"] as string,
        trade: (session["trade"] as string | null) ?? null,
        category: (session["current_category"] as string | null) ?? null,
        topic: (session["current_topic"] as string | null) ?? null,
        question,
        answer: answerText,
      });
      extracted = result.items;
      if (extracted.length > 0) {
        await supabase
          .from("interview_answers")
          .update({ extracted_knowledge: serializeKnowledge(extracted) })
          .eq("id", answerRow["id"]);
      }
      const verification = await verifyAndRecordGraphWrite(result.manifest, { startedAtMs });
      if (verification.status !== "verified") {
        distillationStatus = "failed";
        distillationError = verification.summary;
        publish({ type: "error" });
      }
    } catch (err) {
      req.log.error({ err, answerId: answerRow["id"] }, "mentor answer distillation failed");
      distillationStatus = "failed";
      distillationError = err instanceof Error ? err.message : String(err);
      publish({ type: "error" });
    } finally {
      publish({ type: "memory:write:end" });
    }
    await supabase
      .from("interview_answers")
      .update({ distillation_status: distillationStatus, distillation_error: distillationError })
      .eq("id", answerRow["id"]);
    answerRow["distillation_status"] = distillationStatus;

    const updated = await advanceSession(session, mentor);
    return res.json({
      session: serializeSession(updated, mentor["name"] as string),
      answer: serializeAnswer(answerRow),
      extractedKnowledge: serializeKnowledge(extracted),
    });
  } catch (err) {
    req.log.error({ err }, "submitInterviewAnswer error");
    return res.status(500).json({ error: "Failed to submit answer" });
  }
});

/**
 * POST /interview/sessions/:id/transcribe — voice-answer transcription.
 *
 * Accepts one short audio clip (multipart field "audio") recorded in the browser
 * and returns its Whisper transcript so the mentor can review/edit it before
 * submitting the text via POST .../answers. The audio is NEVER persisted — only
 * the final text answer is stored (privacy: see threat_model.md).
 *
 * DELIBERATE CONTRACT EXCEPTION: like POST /videos/ingest, this multipart route
 * is intentionally NOT in the OpenAPI spec (Orval multipart is awkward for a
 * single tiny endpoint); the client calls it with a manual fetch(FormData).
 *
 * The upload is gated on an existing, ACTIVE session (unguessable UUID) BEFORE
 * the body is buffered, so an anonymous caller cannot push 25 MB through the
 * server or trigger paid Whisper work at will (threat model: paid-compute DoS).
 */
router.post(
  "/interview/sessions/:id/transcribe",
  aiInterviewLimiter,
  async (req, res, next) => {
    try {
      const loaded = await loadSession(req.params.id, req.userId);
      if (!loaded) return res.status(404).json({ error: "Interview session not found" });
      if ((loaded.session["status"] as string) === "completed") {
        return res.status(409).json({ error: "This interview is already complete." });
      }
      return next();
    } catch (err) {
      req.log.error({ err }, "transcribeInterviewAnswer gate error");
      return res.status(500).json({ error: "Failed to transcribe audio" });
    }
  },
  (req, res) => {
    audioUpload(req, res, async (uploadErr: unknown) => {
      try {
        if (uploadErr) {
          if (uploadErr instanceof multer.MulterError) {
            if (uploadErr.code === "LIMIT_FILE_SIZE") {
              return res
                .status(413)
                .json({ error: "That recording is too long. Please record a shorter answer." });
            }
            return res.status(400).json({ error: "Could not read the audio upload." });
          }
          throw uploadErr;
        }

        const file = req.file;
        if (!file || file.buffer.length === 0) {
          return res
            .status(400)
            .json({ error: "No audio was received. Please record your answer again." });
        }

        const transcript = await transcribeAudioBuffer(
          file.buffer,
          `answer.${audioExtension(file.mimetype)}`,
        );
        if (!transcript) {
          return res.status(422).json({
            error: "We couldn't make out any words — please try recording again.",
          });
        }
        return res.json({ transcript });
      } catch (err) {
        req.log.error({ err }, "transcribeInterviewAnswer error");
        return res.status(500).json({ error: "Failed to transcribe audio" });
      }
    });
  },
);

router.post("/interview/sessions/:id/skip", aiInterviewLimiter, async (req, res) => {
  try {
    const loaded = await loadSession(req.params.id, req.userId);
    if (!loaded) return res.status(404).json({ error: "Interview session not found" });
    const { session, mentor } = loaded;

    if ((session["status"] as string) === "completed") {
      return res.status(409).json({ error: "This interview is already complete." });
    }
    const question = session["current_question"] as string | null;
    if (!question) {
      return res.status(409).json({ error: "There is no pending question to skip." });
    }

    const { data: answer, error: aErr } = await supabase
      .from("interview_answers")
      .insert({
        session_id: session["id"],
        mentor_profile_id: session["mentor_profile_id"],
        question,
        category: (session["current_category"] as string | null) ?? null,
        topic: (session["current_topic"] as string | null) ?? null,
        answer_text: null,
        skipped: true,
      })
      .select("*")
      .single();
    if (aErr) throw aErr;

    const updated = await advanceSession(session, mentor);
    return res.json({
      session: serializeSession(updated, mentor["name"] as string),
      answer: serializeAnswer(answer as Row),
      extractedKnowledge: [],
    });
  } catch (err) {
    req.log.error({ err }, "skipInterviewQuestion error");
    return res.status(500).json({ error: "Failed to skip question" });
  }
});

// Admin-gated: re-run distillation + verification for a single answer whose
// knowledge write previously failed (surfaced on the Graph Health dashboard).
// Idempotent — the graph write path reconciles onto the same canonical nodes.
router.post("/interview/answers/:id/redistill", requireAdmin, async (req, res) => {
  try {
    const { data: answer, error: aErr } = await supabase
      .from("interview_answers")
      .select("*")
      .eq("id", req.params.id)
      .maybeSingle();
    if (aErr) throw aErr;
    if (!answer) return res.status(404).json({ error: "Answer not found" });
    const answerRow = answer as Row;

    const answerText = (answerRow["answer_text"] as string | null) ?? "";
    if (Boolean(answerRow["skipped"]) || !answerText.trim()) {
      return res.status(409).json({ error: "This answer has no content to distill." });
    }

    const mentorProfileId = answerRow["mentor_profile_id"] as string;
    const { data: mentor, error: mErr } = await supabase
      .from("mentor_profiles")
      .select("name")
      .eq("id", mentorProfileId)
      .maybeSingle();
    if (mErr) throw mErr;
    if (!mentor) return res.status(404).json({ error: "Mentor not found" });

    const sessionId = (answerRow["session_id"] as string | null) ?? null;
    let trade: string | null = null;
    if (sessionId) {
      const { data: sess } = await supabase
        .from("interview_sessions")
        .select("trade")
        .eq("id", sessionId)
        .maybeSingle();
      trade = (sess?.["trade"] as string | null) ?? null;
    }

    let extracted: MentorDistilledItem[] = [];
    let distillationStatus = "verified";
    let distillationError: string | null = null;
    const startedAtMs = Date.now();
    publish({ type: "memory:write:start" });
    try {
      const result = await runMentorAnswerDistillation({
        mentorProfileId,
        mentorName: (mentor as Row)["name"] as string,
        answerId: answerRow["id"] as string,
        sessionId,
        trade,
        category: (answerRow["category"] as string | null) ?? null,
        topic: (answerRow["topic"] as string | null) ?? null,
        question: (answerRow["question"] as string) ?? "",
        answer: answerText,
      });
      extracted = result.items;
      if (extracted.length > 0) {
        await supabase
          .from("interview_answers")
          .update({ extracted_knowledge: serializeKnowledge(extracted) })
          .eq("id", answerRow["id"]);
      }
      const verification = await verifyAndRecordGraphWrite(result.manifest, { startedAtMs });
      if (verification.status !== "verified") {
        distillationStatus = "failed";
        distillationError = verification.summary;
        publish({ type: "error" });
      }
    } catch (err) {
      req.log.error({ err, answerId: answerRow["id"] }, "mentor answer redistillation failed");
      distillationStatus = "failed";
      distillationError = err instanceof Error ? err.message : String(err);
      publish({ type: "error" });
    } finally {
      publish({ type: "memory:write:end" });
    }
    await supabase
      .from("interview_answers")
      .update({ distillation_status: distillationStatus, distillation_error: distillationError })
      .eq("id", answerRow["id"]);
    answerRow["distillation_status"] = distillationStatus;

    return res.json({
      answer: serializeAnswer(answerRow),
      extractedKnowledge: serializeKnowledge(extracted),
    });
  } catch (err) {
    req.log.error({ err }, "redistillInterviewAnswer error");
    return res.status(500).json({ error: "Failed to redistill answer" });
  }
});

router.post("/interview/sessions/:id/finish", async (req, res) => {
  try {
    const loaded = await loadSession(req.params.id, req.userId);
    if (!loaded) return res.status(404).json({ error: "Interview session not found" });
    const { session, mentor } = loaded;

    const { data: updated, error } = await supabase
      .from("interview_sessions")
      .update({
        status: "completed",
        current_question: null,
        current_category: null,
        current_topic: null,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", session["id"])
      .select("*")
      .single();
    if (error) throw error;

    return res.json(serializeSession(updated as Row, mentor["name"] as string));
  } catch (err) {
    req.log.error({ err }, "finishInterview error");
    return res.status(500).json({ error: "Failed to finish interview" });
  }
});

/**
 * List mentor profiles with contribution counts — admin-gated because names,
 * regions, and backgrounds are personal data that the public product surface
 * never exposes (mentors appear only as provenance on concepts). Counts are
 * computed in-memory from id-only projections, which is fine at library scale.
 */
router.get("/interview/mentors", requireAdmin, async (req, res) => {
  try {
    const { data: mentors, error } = await supabase
      .from("mentor_profiles")
      .select("id, name, trade, trade_input, years_experience, specialties, region, created_at")
      .order("created_at", { ascending: false });
    if (error) throw error;

    const [sessionsRes, answersRes] = await Promise.all([
      supabase.from("interview_sessions").select("mentor_profile_id"),
      supabase.from("interview_answers").select("mentor_profile_id, skipped"),
    ]);
    if (sessionsRes.error) throw sessionsRes.error;
    if (answersRes.error) throw answersRes.error;

    const sessionCounts = new Map<string, number>();
    for (const row of sessionsRes.data ?? []) {
      const id = (row as Row)["mentor_profile_id"] as string | null;
      if (id) sessionCounts.set(id, (sessionCounts.get(id) ?? 0) + 1);
    }
    const answerCounts = new Map<string, number>();
    for (const row of answersRes.data ?? []) {
      const r = row as Row;
      const id = r["mentor_profile_id"] as string | null;
      if (id && !r["skipped"]) answerCounts.set(id, (answerCounts.get(id) ?? 0) + 1);
    }

    const shaped = (mentors ?? []).map((m: Row) => ({
      id: m["id"],
      name: m["name"],
      trade: (m["trade"] as string | null) ?? null,
      tradeInput: (m["trade_input"] as string | null) ?? null,
      yearsExperience: (m["years_experience"] as number | null) ?? null,
      region: (m["region"] as string | null) ?? null,
      specialties: Array.isArray(m["specialties"]) ? (m["specialties"] as string[]) : [],
      sessionCount: sessionCounts.get(m["id"] as string) ?? 0,
      answerCount: answerCounts.get(m["id"] as string) ?? 0,
      createdAt: m["created_at"],
    }));

    return res.json(ListMentorsResponse.parse({ mentors: shaped, total: shaped.length }));
  } catch (err) {
    req.log.error({ err }, "listMentors error");
    return res.status(500).json({ error: "Failed to list mentors" });
  }
});

/**
 * Mentor Withdrawal — admin-gated, destructive. Removes the PERSON (profile,
 * sessions, verbatim answers, candidate attribution) while the Living Memory
 * graph is re-evaluated concept by concept: retained concepts recompute their
 * aggregates from surviving sources; mentor-only concepts are demoted to
 * attribution-free `archived` candidates. All ordering/idempotency lives in
 * withdrawMentor (graph work first, profile row last), so a replay after
 * success is a clean 404 and a mid-flight retry converges.
 */
router.post("/interview/mentors/:id/withdraw", requireAdmin, async (req, res) => {
  try {
    const parsed = WithdrawMentorParams.safeParse(req.params);
    // A malformed id can never name a mentor — same not-found semantics as a
    // missing profile (no oracle for which ids are structurally valid).
    if (!parsed.success || !UUID_RE.test(parsed.data.id)) {
      return res.status(404).json({ error: "Mentor not found" });
    }

    const result = await withdrawMentor(parsed.data.id);
    if (!result.ok) return res.status(404).json({ error: "Mentor not found" });

    req.log.info({ summary: result.summary }, "mentor withdrawn");
    return res.json(WithdrawMentorResponse.parse(result.summary));
  } catch (err) {
    req.log.error({ err }, "withdrawMentor error");
    return res.status(500).json({ error: "Failed to withdraw mentor" });
  }
});

/**
 * Withdrawal impact preview — admin-gated, read-only dry run. Returns the exact
 * counts (and the labels of concepts that would be archived out of the live
 * graph) that a real withdrawal would produce, WITHOUT writing anything, so an
 * admin can make a fully informed decision before this irreversible action.
 * Shares the same concept-evaluation logic as the withdrawal itself.
 */
router.get("/interview/mentors/:id/withdrawal-preview", requireAdmin, async (req, res) => {
  try {
    const parsed = PreviewMentorWithdrawalParams.safeParse(req.params);
    if (!parsed.success || !UUID_RE.test(parsed.data.id)) {
      return res.status(404).json({ error: "Mentor not found" });
    }

    const result = await previewMentorWithdrawal(parsed.data.id);
    if (!result.ok) return res.status(404).json({ error: "Mentor not found" });

    return res.json(PreviewMentorWithdrawalResponse.parse(result.preview));
  } catch (err) {
    req.log.error({ err }, "previewMentorWithdrawal error");
    return res.status(500).json({ error: "Failed to preview mentor withdrawal" });
  }
});

/**
 * Compute and persist the next pending question for a session after an answer or
 * skip. Marks the session completed when the engine signals it has covered the
 * themes. Returns the updated session row.
 */
async function advanceSession(session: Row, mentor: Row): Promise<Row> {
  const history = await loadHistory(session["id"] as string);
  const next = await generateNextQuestion(toProfileLite(mentor), history);
  const completed = next.complete || !next.question;

  const askedRaw = Array.isArray(session["asked_categories"])
    ? (session["asked_categories"] as string[])
    : [];
  const asked = new Set(askedRaw);
  if (!completed) asked.add(next.category);

  const { data: updated, error } = await supabase
    .from("interview_sessions")
    .update({
      status: completed ? "completed" : "active",
      current_question: completed ? null : next.question,
      current_category: completed ? null : next.category,
      current_topic: completed ? null : next.topic,
      asked_categories: [...asked],
      question_count: (session["question_count"] as number) + (completed ? 0 : 1),
      completed_at: completed ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", session["id"])
    .select("*")
    .single();
  if (error) throw error;
  return updated as Row;
}

export default router;
