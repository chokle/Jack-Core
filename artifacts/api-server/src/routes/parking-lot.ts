/**
 * parking-lot routes — "Park This Thought" bookmarks for an interrupted Ask
 * Jack chat conversation or mentor interview. No AI call happens here (titles
 * and summaries are deterministic truncation, not distilled) — this is a
 * lightweight bookmark, not a new knowledge-write surface — but it is still a
 * public write that stores caller-supplied jsonb into Supabase, so it is
 * rate-limited and every field is capped server-side (also enforced by the
 * generated Zod schema's maxLength/maxItems, from the OpenAPI spec).
 *
 * Privacy mirrors chat.ts: chat-sourced rows are scoped to the caller's
 * HttpOnly jack_session cookie, exactly like chat history — a cookie mismatch
 * or missing cookie returns 404, never a "this belongs to someone else"
 * response that would leak existence. Interview-sourced rows are scoped to the
 * authenticated user who owns the underlying interview session. Admin status is
 * not a bypass: nobody can resume another contributor's interview. mentorProfileId/trade/topic/category for an
 * interview-sourced row are NEVER taken from the client — they are always
 * derived server-side from interviewSessionId so a caller cannot mislabel a
 * bookmark as belonging to a mentor/session it doesn't.
 */
import { Router, type Request } from "express";
import { supabase } from "../lib/supabase.js";
import { ParkThoughtBody } from "@workspace/api-zod";
import { readSession, resolveSession } from "../lib/session.js";
import { parkingLotLimiter } from "../lib/rate-limit.js";
import { PRESENTATION_USER_ID } from "../middlewares/resolveApiIdentity.js";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CONTEXT_ITEMS = 5;
const MAX_TEXT_LENGTH = 2000;
const STATUSES = ["parked", "resumed", "resolved"] as const;

type Row = Record<string, unknown>;

function truncate(value: string | null | undefined, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** Deterministic title — no AI call for a lightweight bookmark. */
function deriveTitle(
  topic: string | null,
  unfinishedThought: string | null,
  mentorName: string | null,
): string {
  if (topic) return topic;
  if (unfinishedThought) return truncate(unfinishedThought, 60) ?? "Parked thought";
  if (mentorName) return `Interview with ${mentorName}`;
  return "Parked thought";
}

/** Deterministic summary — no AI call for a lightweight bookmark. */
function deriveSummary(
  unfinishedThought: string | null,
  context: Array<{ role: string; text: string }>,
): string {
  if (unfinishedThought) return truncate(unfinishedThought, 160) ?? unfinishedThought;
  const last = context[context.length - 1];
  if (last?.text) return truncate(last.text, 160) ?? last.text;
  return "No additional detail captured.";
}

function serialize(row: Row): Record<string, unknown> {
  return {
    id: row["id"],
    source: row["source"],
    interviewSessionId: row["interview_session_id"] ?? null,
    mentorProfileId: row["mentor_profile_id"] ?? null,
    mentorName: row["mentor_name"] ?? null,
    trade: row["trade"] ?? null,
    category: row["category"] ?? null,
    topic: row["topic"] ?? null,
    title: row["title"],
    summary: row["summary"],
    unfinishedThought: row["unfinished_thought"] ?? null,
    reason: row["reason"] ?? null,
    context: row["context_snapshot"] ?? [],
    status: row["status"],
    createdAt: row["created_at"],
    updatedAt: row["updated_at"] ?? null,
    canManage: true,
  };
}

/**
 * Check whether the authenticated caller owns the interview session behind a
 * parked interview thought. This deliberately ignores admin status: resuming an
 * interview means continuing as the contributor, so ownership is the only gate.
 */
async function canAccessInterviewThought(req: Request, row: Row): Promise<boolean> {
  const sessionId = row["interview_session_id"];
  if (row["source"] !== "interview") return true;
  if (
    typeof sessionId !== "string" ||
    !UUID_RE.test(sessionId) ||
    !req.userId ||
    req.userId === PRESENTATION_USER_ID
  ) return false;

  const { data, error } = await supabase
    .from("interview_sessions")
    .select("contributor_user_id")
    .eq("id", sessionId)
    .eq("contributor_user_id", req.userId)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

/**
 * Load a row by id and enforce the privacy rule: a chat-sourced row is only
 * accessible to the cookie that created it; an interview-sourced row is only
 * accessible to the authenticated user who created/owns the interview session.
 * Returns null for "doesn't exist" AND "exists but not yours" so the caller can
 * return a single 404 without leaking which case it was.
 */
async function findAccessibleRow(req: Request, id: string): Promise<Row | null> {
  const { data, error } = await supabase
    .from("parked_thoughts")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as Row;
  if (row["source"] === "chat") {
    const session = readSession(req);
    if (!session || row["chat_session_id"] !== session) return null;
  }
  if (row["source"] === "interview" && !(await canAccessInterviewThought(req, row))) {
    return null;
  }
  return row;
}

router.post("/parking-lot", parkingLotLimiter, async (req, res) => {
  try {
    const parsed = ParkThoughtBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const body = parsed.data;

    const context = (body.context ?? [])
      .slice(0, MAX_CONTEXT_ITEMS)
      .map((c) => ({
        role: c.role,
        text: truncate(c.text, MAX_TEXT_LENGTH) ?? "",
        at: c.at ?? null,
      }));
    const unfinishedThought = truncate(body.unfinishedThought, MAX_TEXT_LENGTH);
    const reason = truncate(body.reason, 500);

    let chatSessionId: string | null = null;
    let interviewSessionId: string | null = null;
    let mentorProfileId: string | null = null;
    let mentorName: string | null = null;
    let trade: string | null = null;
    let category: string | null = null;
    let topic: string | null = null;

    if (body.source === "interview") {
      if (!req.userId || req.userId === PRESENTATION_USER_ID) {
        return res.status(401).json({ error: "Sign in is required to park an interview." });
      }
      const sid = body.interviewSessionId;
      if (typeof sid !== "string" || !UUID_RE.test(sid)) {
        return res.status(400).json({
          error: "interviewSessionId is required for an interview-sourced thought",
        });
      }
      const { data: session, error: sErr } = await supabase
        .from("interview_sessions")
        .select("*")
        .eq("id", sid)
        .eq("contributor_user_id", req.userId)
        .maybeSingle();
      if (sErr) throw sErr;
      if (!session) return res.status(400).json({ error: "Unknown interviewSessionId" });

      const { data: mentor, error: mErr } = await supabase
        .from("mentor_profiles")
        .select("name")
        .eq("id", session["mentor_profile_id"])
        .maybeSingle();
      if (mErr) throw mErr;

      // Attribution for an interview-sourced row is ALWAYS derived from the
      // session, never from the request body — a caller cannot mislabel a
      // bookmark as belonging to a mentor/trade/topic it doesn't.
      interviewSessionId = sid;
      mentorProfileId = (session["mentor_profile_id"] as string) ?? null;
      mentorName = (mentor?.["name"] as string | undefined) ?? null;
      trade = (session["trade"] as string | null) ?? null;
      category = (session["current_category"] as string | null) ?? null;
      topic = (session["current_topic"] as string | null) ?? null;
    } else {
      chatSessionId = resolveSession(req, res);
      category = truncate(body.category, 200);
      topic = truncate(body.topic, 200);
    }

    const title = deriveTitle(topic, unfinishedThought, mentorName);
    const summary = deriveSummary(unfinishedThought, context);

    const { data: inserted, error: insErr } = await supabase
      .from("parked_thoughts")
      .insert({
        source: body.source,
        chat_session_id: chatSessionId,
        interview_session_id: interviewSessionId,
        mentor_profile_id: mentorProfileId,
        mentor_name: mentorName,
        trade,
        category,
        topic,
        title,
        summary,
        unfinished_thought: unfinishedThought,
        reason,
        context_snapshot: context,
      })
      .select("*")
      .single();
    if (insErr) throw insErr;

    return res.status(201).json(serialize(inserted as Row));
  } catch (err) {
    req.log.error({ err }, "parkThought error");
    return res.status(500).json({ error: "Failed to park thought" });
  }
});

router.get("/parking-lot", async (req, res) => {
  try {
    const session = readSession(req);
    const statusParam = req.query["status"];
    const status =
      typeof statusParam === "string" && (STATUSES as readonly string[]).includes(statusParam)
        ? statusParam
        : undefined;
    const mentorProfileIdParam = req.query["mentorProfileId"];
    const mentorProfileId =
      typeof mentorProfileIdParam === "string" ? mentorProfileIdParam : undefined;

    let query = supabase
      .from("parked_thoughts")
      .select("*")
      .order("created_at", { ascending: false });

    if (status) query = query.eq("status", status);
    if (mentorProfileId) query = query.eq("mentor_profile_id", mentorProfileId);

    // Privacy: chat-sourced rows are only visible to the cookie that created
    // them; interview-sourced rows are filtered below against the authenticated
    // session owner. `.or()` builds a raw PostgREST
    // filter string, so the session value MUST be validated as a UUID before
    // being inlined — an unvalidated cookie could inject extra `,`-separated
    // disjuncts and disclose other sessions' chat-sourced parked thoughts.
    const safeSession = session && UUID_RE.test(session) ? session : null;
    const canOwnInterview = Boolean(req.userId && req.userId !== PRESENTATION_USER_ID);
    query = canOwnInterview
      ? safeSession
        ? query.or(`source.eq.interview,chat_session_id.eq.${safeSession}`)
        : query.eq("source", "interview")
      : safeSession
        ? query.eq("chat_session_id", safeSession)
        : query.eq("source", "chat").is("id", null);
    if (req.userId) {
      // Supabase/PostgREST cannot filter parked_thoughts by the joined
      // interview session owner here, so we still verify each row below. This
      // keeps the initial candidate set bounded to interview rows plus the
      // caller's chat rows without ever trusting the client for ownership.
    }

    const { data, error } = await query;
    if (error) throw error;

    const visible: Row[] = [];
    for (const r of data ?? []) {
      const row = r as Row;
      if (row["source"] === "interview" && !(await canAccessInterviewThought(req, row))) {
        continue;
      }
      visible.push(row);
    }

    return res.json({ items: visible.map((r) => serialize(r)) });
  } catch (err) {
    req.log.error({ err }, "listParkedThoughts error");
    return res.status(500).json({ error: "Failed to list parked thoughts" });
  }
});

router.post("/parking-lot/:id/resume", async (req, res) => {
  try {
    const id = String(req.params.id ?? "");
    if (!UUID_RE.test(id)) return res.status(404).json({ error: "Parked thought not found" });
    const row = await findAccessibleRow(req, id);
    if (!row) return res.status(404).json({ error: "Parked thought not found" });

    const { data, error } = await supabase
      .from("parked_thoughts")
      .update({ status: "resumed", updated_at: new Date().toISOString() })
      .eq("id", id)
      .select("*")
      .single();
    if (error) throw error;

    return res.json(serialize(data as Row));
  } catch (err) {
    req.log.error({ err }, "resumeParkedThought error");
    return res.status(500).json({ error: "Failed to resume parked thought" });
  }
});

router.post("/parking-lot/:id/archive", async (req, res) => {
  try {
    const id = String(req.params.id ?? "");
    if (!UUID_RE.test(id)) return res.status(404).json({ error: "Parked thought not found" });
    const row = await findAccessibleRow(req, id);
    if (!row) return res.status(404).json({ error: "Parked thought not found" });

    const { data, error } = await supabase
      .from("parked_thoughts")
      .update({ status: "resolved", updated_at: new Date().toISOString() })
      .eq("id", id)
      .select("*")
      .single();
    if (error) throw error;

    return res.json(serialize(data as Row));
  } catch (err) {
    req.log.error({ err }, "archiveParkedThought error");
    return res.status(500).json({ error: "Failed to archive parked thought" });
  }
});

export default router;
