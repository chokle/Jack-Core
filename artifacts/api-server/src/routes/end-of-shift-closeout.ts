import { Router, type Request, type Response } from "express";
import { resolveIdentity } from "../lib/admin-auth.js";
import { denyRestrictedIdentity } from "../lib/identity.js";
import { activityDb, resolveActiveTesterScope } from "../lib/activity-telemetry.js";

const router = Router();

const CLOSEOUT_QUESTIONS = [
  "tasksCompleted",
  "safetyConcerns",
  "handoverReadiness",
  "teamCoordination",
  "materialAndTools",
  "nextShiftPriorities",
] as const;
const CLOSEOUT_STATES = new Set(["draft", "submitted"]);
const CLOSEOUT_SHIFT_VALUES = new Set(["day", "swing", "night"]);
const WORK_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type CloseoutQuestion = (typeof CLOSEOUT_QUESTIONS)[number];
type CloseoutShift = "day" | "swing" | "night";
type CloseoutStatus = "draft" | "submitted";
type ClientCloseoutState = "not_started" | CloseoutStatus;

interface ParticipantScope {
  actorUserId: string;
  organizationId: string;
  pilotId: string;
}

interface CloseoutRow {
  id: string;
  actor_user_id: string;
  organization_id: string;
  pilot_id: string;
  work_date: string;
  shift: CloseoutShift;
  crew: string | null;
  trade: string | null;
  answers: Record<string, string>;
  status: CloseoutStatus;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
}

interface CloseoutPayload {
  workDate: string;
  shift: CloseoutShift;
  status: CloseoutStatus;
  answers: Record<string, string>;
}

interface CloseoutResponse {
  scope: {
    actorUserId: string;
    organizationId: string;
    pilotId: string;
  };
  workDate: string;
  shift: CloseoutShift;
  state: ClientCloseoutState;
  closeout: {
    id: string;
    actorUserId: string;
    organizationId: string;
    pilotId: string;
    workDate: string;
    shift: CloseoutShift;
    crew: string | null;
    trade: string | null;
    answers: Record<string, string>;
    status: CloseoutStatus;
    submittedAt: string | null;
    createdAt: string;
    updatedAt: string;
  } | null;
  crew: string | null;
  trade: string | null;
  availableQuestions: typeof CLOSEOUT_QUESTIONS;
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function asShift(raw: unknown): CloseoutShift | "" {
  if (!isText(raw)) return "";
  const shift = raw.trim().toLowerCase();
  return CLOSEOUT_SHIFT_VALUES.has(shift) ? (shift as CloseoutShift) : "";
}

function parseWorkDate(raw: unknown): string {
  if (!isText(raw)) return todaysIsoDate();
  const value = raw.trim();
  return WORK_DATE_RE.test(value) ? value : todaysIsoDate();
}

function parseWorkDateOrNull(raw: unknown): string | null {
  if (!isText(raw)) return null;
  const value = raw.trim();
  return WORK_DATE_RE.test(value) ? value : null;
}

function todaysIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function sanitizeAnswer(raw: unknown): string | null {
  if (!isText(raw)) return null;
  const text = raw.trim();
  return text.length > 0 && text.length <= 1_000 ? text : null;
}

function payloadAnswers(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  if (!Object.keys(input).every((key) => CLOSEOUT_QUESTIONS.includes(key as CloseoutQuestion))) {
    return null;
  }
  const normalized: Record<string, string> = {};
  for (const key of CLOSEOUT_QUESTIONS) {
    const value = sanitizeAnswer(input[key]);
    if (value === null) continue;
    normalized[key] = value;
  }
  return normalized;
}

function parsePayload(body: unknown): CloseoutPayload | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const raw = body as Record<string, unknown>;
  const explicitDate = parseWorkDateOrNull(raw["workDate"]);
  if (isText(raw["workDate"]) && explicitDate === null) return null;

  const workDate = parseWorkDate(raw["workDate"]);
  const shift = asShift(raw["shift"]);
  const status = isText(raw["status"]) && CLOSEOUT_STATES.has(raw["status"].trim()) ?
    (raw["status"].trim() as CloseoutStatus)
    : "";
  const answers = payloadAnswers(raw["answers"]);
  if (!shift || !status || !answers) return null;

  return {
    workDate,
    shift,
    status,
    answers,
  };
}

function answersMatch(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

function isDraftComplete(answers: Record<string, string>): boolean {
  return CLOSEOUT_QUESTIONS.every((question) => isText(answers[question]));
}

function serializeCloseout(row: CloseoutRow) {
  return {
    id: row.id,
    actorUserId: row.actor_user_id,
    organizationId: row.organization_id,
    pilotId: row.pilot_id,
    workDate: row.work_date,
    shift: row.shift,
    crew: row.crew,
    trade: row.trade,
    answers: row.answers,
    status: row.status,
    submittedAt: row.submitted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function closeoutState(row: CloseoutRow | null): ClientCloseoutState {
  return row ? row.status : "not_started";
}

async function loadTradeFromMentorProfile(actorUserId: string): Promise<string | null> {
  const profile = await activityDb
    .from("mentor_profiles")
    .select("trade")
    .eq("contributor_user_id", actorUserId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (profile.error) return null;
  const trade = profile.data?.trade;
  return typeof trade === "string" && trade.trim().length > 0 ? trade.trim() : null;
}

async function loadCloseout(scope: ParticipantScope, workDate: string, shift: CloseoutShift) {
  const row = await activityDb
    .from("end_of_shift_closeouts")
    .select("*")
    .eq("actor_user_id", scope.actorUserId)
    .eq("organization_id", scope.organizationId)
    .eq("pilot_id", scope.pilotId)
    .eq("work_date", workDate)
    .eq("shift", shift)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (row.error) throw row.error;
  return row.data ? (row.data as unknown as CloseoutRow) : null;
}

async function requireParticipantScope(req: Request, res: Response): Promise<ParticipantScope | null> {
  const identity = await resolveIdentity(req);
  if (!identity) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  if (
    denyRestrictedIdentity(
      res,
      identity,
      "Closeout reporting is unavailable for this account.",
      "Closeout reporting is temporarily unavailable.",
    )
  ) return null;
  if (identity.isAdmin) {
    res.status(403).json({ error: "Closeout reporting is not available for administrators." });
    return null;
  }

  const membership = await resolveActiveTesterScope(identity.userId);
  if (!membership.scope) {
    return res
      .status(membership.reason === "ambiguous_pilot" ? 409 : 403)
      .json({ error: "No active tester membership was found." }) as null;
  }
  return {
    actorUserId: identity.userId,
    organizationId: membership.scope.organizationId,
    pilotId: membership.scope.pilotId,
  };
}

async function saveCloseout(scope: ParticipantScope, payload: CloseoutPayload) {
  const existing = await loadCloseout(scope, payload.workDate, payload.shift);
  const now = new Date().toISOString();
  const trade = await loadTradeFromMentorProfile(scope.actorUserId);

  if (existing?.status === "submitted") {
    if (
      payload.status === "submitted" &&
      answersMatch(existing.answers, payload.answers)
    ) {
      return { status: 200, row: existing, state: "submitted" as ClientCloseoutState };
    }
    return { status: 409, row: existing, state: "submitted" as ClientCloseoutState };
  }

  if (payload.status === "submitted" && !isDraftComplete(payload.answers)) {
    return { status: 400, row: existing, state: "not_started" as ClientCloseoutState };
  }

  const rowData = {
    actor_user_id: scope.actorUserId,
    organization_id: scope.organizationId,
    pilot_id: scope.pilotId,
    work_date: payload.workDate,
    shift: payload.shift,
    crew: existing?.crew ?? null,
    trade: trade ?? existing?.trade ?? null,
    answers: payload.answers,
    status: payload.status,
    submitted_at: payload.status === "submitted" ? now : null,
    updated_at: now,
  };

  if (existing) {
    const updated = await activityDb
      .from("end_of_shift_closeouts")
      .update({
        answers: payload.answers,
        status: payload.status,
        crew: rowData.crew,
        trade: rowData.trade,
        submitted_at: rowData.submitted_at,
        updated_at: now,
      })
      .eq("id", existing.id)
      .eq("status", "draft")
      .select("*")
      .maybeSingle();
    if (updated.error) throw updated.error;
    if (updated.data) {
      return { status: 200, row: updated.data as unknown as CloseoutRow, state: payload.status };
    }
    const current = await loadCloseout(scope, payload.workDate, payload.shift);
    if (current) {
      return { status: 409, row: current, state: "submitted" };
    }
    return { status: 409, row: null, state: "not_started" };
  }

  const inserted = await activityDb
    .from("end_of_shift_closeouts")
    .insert(rowData)
    .select("*")
    .maybeSingle();
  if (inserted.error) {
    if (inserted.error.code === "23505") {
      const duplicate = await loadCloseout(scope, payload.workDate, payload.shift);
      if (!duplicate) throw inserted.error;
      if (
        duplicate.status === "submitted" &&
        duplicate.status === payload.status &&
        answersMatch(duplicate.answers, payload.answers)
      ) {
        return { status: 200, row: duplicate, state: "submitted" };
      }
      return { status: 409, row: duplicate, state: duplicate.status };
    }
    throw inserted.error;
  }
  return {
    status: 201,
    row: inserted.data as unknown as CloseoutRow,
    state: "draft",
  };
}

router.get("/testing/closeouts", async (req, res) => {
  try {
    const scope = await requireParticipantScope(req, res);
    if (!scope) return;
    const workDate = parseWorkDate(req.query["workDate"]);
    const shift = asShift(req.query["shift"]) || "day";
    const closeout = await loadCloseout(scope, workDate, shift);
    const trade = closeout?.trade ?? (await loadTradeFromMentorProfile(scope.actorUserId));
    return res.json({
      scope,
      workDate,
      shift,
      state: closeoutState(closeout),
      closeout: closeout ? serializeCloseout(closeout) : null,
      crew: closeout?.crew ?? null,
      trade,
      availableQuestions: CLOSEOUT_QUESTIONS,
    } as CloseoutResponse);
  } catch (error) {
    req.log.error({ err: error }, "could not load closeout");
    return res.status(503).json({ error: "Failed to load closeout." });
  }
});

router.post("/testing/closeouts", async (req, res) => {
  try {
    const scope = await requireParticipantScope(req, res);
    if (!scope) return;
    const payload = parsePayload(req.body);
    if (!payload) return res.status(400).json({ error: "Invalid closeout payload." });

    const result = await saveCloseout(scope, payload);
    if (result.status === 400) {
      return res
        .status(400)
        .json({ error: "Submitted closeout requires all questions to be answered." });
    }
    if (result.status === 409) {
      return result.row?.status === "submitted"
        ? res.status(409).json({
            error: "This closeout has already been submitted and cannot be replaced.",
          })
        : res.status(409).json({ error: "Closeout state changed; reload and try again." });
    }
    if (!result.row) {
      return res.status(503).json({ error: "Could not save closeout." });
    }
    return res.status(result.status).json({
      state: closeoutState(result.row),
      closeout: serializeCloseout(result.row),
    });
  } catch (error) {
    req.log.error({ err: error }, "could not save closeout");
    return res.status(503).json({ error: "Failed to save closeout." });
  }
});

export default router;
