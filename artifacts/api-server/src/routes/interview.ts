/**
 * interview routes — Jack Interview Mode.
 *
 * A conversational, no-auth flow where an experienced tradesperson is interviewed
 * by Jack one question at a time. Every answer is stored VERBATIM, distilled into
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
import { supabase } from "../lib/supabase.js";
import { StartInterviewBody, SubmitInterviewAnswerBody } from "@workspace/api-zod";
import { aiInterviewLimiter } from "../lib/rate-limit.js";
import {
  generateNextQuestion,
  normalizeTrade,
  type AnsweredTurn,
  type MentorProfileLite,
} from "../lib/interview.js";
import { runMentorAnswerDistillation, type AtomicKnowledge } from "../lib/distillation.js";

const router = Router();

const MAX_ANSWER_LENGTH = 8000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  return {
    id: answer["id"],
    question: answer["question"],
    category: (answer["category"] as string | null) ?? null,
    topic: (answer["topic"] as string | null) ?? null,
    answerText: (answer["answer_text"] as string | null) ?? null,
    skipped: Boolean(answer["skipped"]),
    createdAt: answer["created_at"],
  };
}

/** Snapshot distilled knowledge for the answer row + the API response. */
function serializeKnowledge(items: AtomicKnowledge[]): Array<Record<string, unknown>> {
  return items.map((k) => ({
    id: k.id,
    title: k.title,
    description: k.description,
    category: k.category,
    confidence: k.confidence,
    competencyCode: k.competencyCode,
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

/** Fetch a session and its mentor, or null if the id is malformed / not found. */
async function loadSession(
  rawId: string | string[] | undefined,
): Promise<{ session: Row; mentor: Row } | null> {
  const id = String(rawId ?? "");
  if (!UUID_RE.test(id)) return null;
  const { data: session, error } = await supabase
    .from("interview_sessions")
    .select("*")
    .eq("id", id)
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
  return { session: session as Row, mentor: mentor as Row };
}

router.post("/interview/sessions", aiInterviewLimiter, async (req, res) => {
  try {
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
    const loaded = await loadSession(req.params.id);
    if (!loaded) return res.status(404).json({ error: "Interview session not found" });
    return res.json(serializeSession(loaded.session, loaded.mentor["name"] as string));
  } catch (err) {
    req.log.error({ err }, "getInterviewSession error");
    return res.status(500).json({ error: "Failed to load interview session" });
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

    const loaded = await loadSession(req.params.id);
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

    // Best-effort distillation into the shared graph. Failure logs and continues.
    let extracted: AtomicKnowledge[] = [];
    try {
      extracted = await runMentorAnswerDistillation({
        mentorProfileId: session["mentor_profile_id"] as string,
        mentorName: mentor["name"] as string,
        answerId: answerRow["id"] as string,
        trade: (session["trade"] as string | null) ?? null,
        category: (session["current_category"] as string | null) ?? null,
        topic: (session["current_topic"] as string | null) ?? null,
        question,
        answer: answerText,
      });
      if (extracted.length > 0) {
        await supabase
          .from("interview_answers")
          .update({ extracted_knowledge: serializeKnowledge(extracted) })
          .eq("id", answerRow["id"]);
      }
    } catch (err) {
      req.log.error({ err, answerId: answerRow["id"] }, "mentor answer distillation failed");
    }

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

router.post("/interview/sessions/:id/skip", aiInterviewLimiter, async (req, res) => {
  try {
    const loaded = await loadSession(req.params.id);
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

router.post("/interview/sessions/:id/finish", async (req, res) => {
  try {
    const loaded = await loadSession(req.params.id);
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
