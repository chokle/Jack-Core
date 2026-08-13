import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { resolveIdentity } from "../lib/admin-auth.js";
import { denyRestrictedIdentity } from "../lib/identity.js";
import {
  buildPilotEndOfDayReport,
  hasCompleteHeartbeatCoverage,
} from "../lib/pilot-end-of-day-report.js";
import {
  activityDb as db,
  auditReportAccess,
  authorizeReportScope,
  listReportScopes,
  requestIdentifier,
  type PilotScope,
} from "../lib/activity-telemetry.js";

const router = Router();
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USER_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

interface AuthorizedScope extends PilotScope {
  authority: "pilot_admin" | "organization_admin" | "platform_superadmin";
  userId: string;
}

async function requireReportScope(
  req: Request,
  res: Response,
  action: string,
): Promise<AuthorizedScope | null> {
  const identity = await resolveIdentity(req);
  if (!identity) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  if (
    denyRestrictedIdentity(
      res,
      identity,
      "Reports are unavailable in presentation mode.",
      "Reports are temporarily unavailable.",
    )
  ) return null;
  const organizationId =
    typeof req.query["organizationId"] === "string" ? req.query["organizationId"] : "";
  const pilotId = typeof req.query["pilotId"] === "string" ? req.query["pilotId"] : "";
  const authorization = await authorizeReportScope(identity.userId, organizationId, pilotId);
  await auditReportAccess({
    userId: identity.userId,
    targetUserId:
      typeof req.params.userId === "string" && USER_ID_RE.test(req.params.userId)
        ? req.params.userId
        : null,
    organizationId: UUID_RE.test(organizationId) ? organizationId : null,
    pilotId: UUID_RE.test(pilotId) ? pilotId : null,
    action,
    decision: authorization.allowed ? "allowed" : "denied",
    authority: authorization.authority,
    requestId: requestIdentifier(req),
  });
  if (!authorization.allowed || !authorization.authority) {
    res.status(403).json({ error: "No active report role exists for this organization and pilot." });
    return null;
  }
  return {
    userId: identity.userId,
    organizationId,
    pilotId,
    authority: authorization.authority as AuthorizedScope["authority"],
  };
}

function eventCounts(events: Array<Record<string, unknown>>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    const type = String(event["event_type"] ?? "unknown");
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return counts;
}

function buildSummary(
  sessions: Array<Record<string, unknown>>,
  events: Array<Record<string, unknown>>,
  feedback: Array<Record<string, unknown>>,
  failures: Array<Record<string, unknown>>,
) {
  const actors = new Set(sessions.map((session) => String(session["actor_user_id"])));
  const completed = sessions.filter((session) => session["status"] === "completed").length;
  const active = sessions.filter((session) => session["status"] === "active").length;
  const onboardingCompleted = sessions.filter(
    (session) => session["onboarding_status"] === "completed",
  ).length;
  const recordingOptIns = sessions.filter(
    (session) => session["screen_consent_state"] === "granted",
  ).length;
  const dropped = failures
    .filter((failure) => failure["outcome"] === "dropped")
    .reduce((sum, failure) => sum + Number(failure["event_count"] ?? 0), 0);
  const rejected = failures
    .filter((failure) => failure["outcome"] === "rejected")
    .reduce((sum, failure) => sum + Number(failure["event_count"] ?? 0), 0);
  return {
    participantCount: actors.size,
    sessionCount: sessions.length,
    activeSessions: active,
    completedSessions: completed,
    completionRate: sessions.length ? completed / sessions.length : 0,
    onboardingCompletionRate: sessions.length ? onboardingCompleted / sessions.length : 0,
    recordingOptInRate: sessions.length ? recordingOptIns / sessions.length : 0,
    feedbackCount: feedback.length,
    droppedEventCount: dropped,
    rejectedEventCount: rejected,
    eventCounts: eventCounts(events),
  };
}

async function loadScopeRows(scope: PilotScope) {
  const [sessions, events, feedback, failures] = await Promise.all([
    db
      .from("test_sessions")
      .select("*")
      .eq("organization_id", scope.organizationId)
      .eq("pilot_id", scope.pilotId)
      .order("last_activity_at", { ascending: false }),
    db
      .from("test_events")
      .select("*")
      .eq("organization_id", scope.organizationId)
      .eq("pilot_id", scope.pilotId)
      .order("occurred_at", { ascending: true }),
    db
      .from("test_feedback")
      .select("*")
      .eq("organization_id", scope.organizationId)
      .eq("pilot_id", scope.pilotId),
    db
      .from("activity_ingest_failures")
      .select("*")
      .eq("organization_id", scope.organizationId)
      .eq("pilot_id", scope.pilotId),
  ]);
  const failed = [sessions, events, feedback, failures].find((result) => result.error);
  if (failed?.error) throw failed.error;
  return {
    sessions: (sessions.data ?? []) as Array<Record<string, unknown>>,
    events: (events.data ?? []) as Array<Record<string, unknown>>,
    feedback: (feedback.data ?? []) as Array<Record<string, unknown>>,
    failures: (failures.data ?? []) as Array<Record<string, unknown>>,
  };
}

async function loadEndOfDayRows(scope: PilotScope, windowStart: string, windowEnd: string) {
  const [memberships, sessions, events, feedback, failures] = await Promise.all([
    db.from("pilot_memberships").select("user_id,role,active,valid_from,valid_until")
      .eq("organization_id", scope.organizationId).eq("pilot_id", scope.pilotId)
      .eq("role", "tester"),
    db.from("test_sessions").select("*")
      .eq("organization_id", scope.organizationId).eq("pilot_id", scope.pilotId)
      .gte("last_activity_at", windowStart).lt("started_at", windowEnd),
    db.from("test_events").select("*")
      .eq("organization_id", scope.organizationId).eq("pilot_id", scope.pilotId)
      .gte("occurred_at", windowStart).lt("occurred_at", windowEnd)
      .order("occurred_at", { ascending: true }),
    db.from("test_feedback").select("*")
      .eq("organization_id", scope.organizationId).eq("pilot_id", scope.pilotId)
      .gte("created_at", windowStart).lt("created_at", windowEnd),
    db.from("activity_ingest_failures").select("*")
      .eq("organization_id", scope.organizationId).eq("pilot_id", scope.pilotId)
      .gte("created_at", windowStart).lt("created_at", windowEnd),
  ]);
  const failed = [memberships, sessions, events, feedback, failures].find((result) => result.error);
  if (failed?.error) throw failed.error;
  const startMs = Date.parse(windowStart);
  const endMs = Date.parse(windowEnd);
  return {
    memberships: (memberships.data ?? []).filter((row: Record<string, unknown>) => {
      const validFrom = Date.parse(String(row["valid_from"] ?? ""));
      const validUntil = row["valid_until"] ? Date.parse(String(row["valid_until"])) : Infinity;
      return (!Number.isFinite(validFrom) || validFrom < endMs) && validUntil > startMs;
    }) as Array<Record<string, unknown>>,
    sessions: (sessions.data ?? []) as Array<Record<string, unknown>>,
    events: (events.data ?? []) as Array<Record<string, unknown>>,
    feedback: (feedback.data ?? []) as Array<Record<string, unknown>>,
    failures: (failures.data ?? []) as Array<Record<string, unknown>>,
  };
}

function utcDayWindow(value: unknown): { start: string; end: string } | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const start = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(start.getTime()) || start.toISOString().slice(0, 10) !== value) return null;
  return { start: start.toISOString(), end: new Date(start.getTime() + 86_400_000).toISOString() };
}

function serializeSession(row: Record<string, unknown>) {
  return {
    id: row["id"],
    actorUserId: row["actor_user_id"],
    status: row["status"],
    startedAt: row["started_at"],
    resumedAt: row["resumed_at"],
    lastActivityAt: row["last_activity_at"],
    onboardingStatus: row["onboarding_status"],
    onboardingStep: row["onboarding_step"],
    questionCount: row["question_count"],
    screenConsentState: row["screen_consent_state"],
    microphoneConsentState: row["microphone_consent_state"],
    recordingStatus: row["recording_status"],
    feedbackStatus: row["feedback_status"],
    completedAt: row["completed_at"],
    errorCount: row["error_count"],
  };
}

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

router.get("/testing/reports/scopes", async (req, res) => {
  try {
    const identity = await resolveIdentity(req);
    if (!identity) return res.status(401).json({ error: "Unauthorized" });
    if (
      denyRestrictedIdentity(
        res,
        identity,
        "Reports are unavailable in presentation mode.",
        "Report scopes could not be loaded.",
      )
    ) return;
    return res.json({ scopes: await listReportScopes(identity.userId) });
  } catch (error) {
    req.log.error({ err: error }, "Could not list report scopes");
    return res.status(503).json({ error: "Report scopes could not be loaded." });
  }
});

router.get("/testing/reports/summary", async (req, res) => {
  try {
    const scope = await requireReportScope(req, res, "pilot_report_summary");
    if (!scope) return;
    const rows = await loadScopeRows(scope);
    return res.json({
      scope: { organizationId: scope.organizationId, pilotId: scope.pilotId },
      summary: buildSummary(rows.sessions, rows.events, rows.feedback, rows.failures),
      users: rows.sessions.map(serializeSession),
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    req.log.error({ err: error }, "Could not generate pilot report summary");
    return res.status(503).json({ error: "Pilot report could not be generated." });
  }
});

router.get("/testing/reports/end-of-day", async (req, res) => {
  try {
    const scope = await requireReportScope(req, res, "pilot_end_of_day_report");
    if (!scope) return;
    const window = utcDayWindow(req.query["date"]);
    if (!window) return res.status(400).json({ error: "A valid UTC report date is required." });
    const rows = await loadEndOfDayRows(scope, window.start, window.end);
    const hasHeartbeatEvidence = hasCompleteHeartbeatCoverage({
      windowStart: window.start,
      windowEnd: window.end,
      sessions: rows.sessions,
      events: rows.events,
    });
    const report = buildPilotEndOfDayReport({
      windowStart: window.start,
      windowEnd: window.end,
      ...rows,
      telemetryHealth: hasHeartbeatEvidence
        ? { windowStart: window.start, windowEnd: window.end, status: "healthy" }
        : null,
    });
    res.setHeader("Cache-Control", "no-store");
    return res.json({
      scope: { organizationId: scope.organizationId, pilotId: scope.pilotId },
      report,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    req.log.error({ err: error }, "Could not generate end-of-day pilot report");
    return res.status(503).json({ error: "End-of-day pilot report could not be generated." });
  }
});

router.get("/testing/progress", async (req, res) => {
  try {
    const scope = await requireReportScope(req, res, "pilot_progress_list");
    if (!scope) return;
    const sessions = await db
      .from("test_sessions")
      .select("*")
      .eq("organization_id", scope.organizationId)
      .eq("pilot_id", scope.pilotId)
      .order("last_activity_at", { ascending: false })
      .limit(250);
    if (sessions.error) throw sessions.error;
    return res.json({ testers: (sessions.data ?? []).map(serializeSession) });
  } catch (error) {
    req.log.error({ err: error }, "Could not load scoped test progress");
    return res.status(503).json({ error: "Test progress could not be loaded." });
  }
});

router.get("/testing/reports/users/:userId/timeline", async (req, res) => {
  try {
    const scope = await requireReportScope(req, res, "pilot_user_timeline");
    if (!scope) return;
    const actorUserId = typeof req.params.userId === "string" ? req.params.userId : "";
    if (!USER_ID_RE.test(actorUserId)) return res.status(400).json({ error: "Invalid user id." });
    const participant = await db
      .from("test_sessions")
      .select("id")
      .eq("actor_user_id", actorUserId)
      .eq("organization_id", scope.organizationId)
      .eq("pilot_id", scope.pilotId)
      .limit(1)
      .maybeSingle();
    if (participant.error) throw participant.error;
    if (!participant.data) return res.status(404).json({ error: "Pilot participant not found." });
    const events = await db
      .from("test_events")
      .select("event_id,event_type,occurred_at,surface,result,metadata,schema_version")
      .eq("organization_id", scope.organizationId)
      .eq("pilot_id", scope.pilotId)
      .eq("actor_user_id", actorUserId)
      .order("occurred_at", { ascending: true });
    if (events.error) throw events.error;
    return res.json({
      actorUserId,
      events: (events.data ?? []).map((row: Record<string, unknown>) => ({
        eventId: row["event_id"],
        eventType: row["event_type"],
        occurredAt: row["occurred_at"],
        surface: row["surface"],
        result: row["result"],
        metadata: row["metadata"],
        schemaVersion: row["schema_version"],
      })),
    });
  } catch (error) {
    req.log.error({ err: error }, "Could not load pilot timeline");
    return res.status(503).json({ error: "Pilot timeline could not be loaded." });
  }
});

router.get("/testing/reports/export.csv", async (req, res) => {
  try {
    const scope = await requireReportScope(req, res, "pilot_report_csv_export");
    if (!scope) return;
    const rows = await loadScopeRows(scope);
    const countsBySession = new Map<string, Record<string, number>>();
    for (const event of rows.events) {
      const sessionId = String(event["test_session_id"]);
      const type = String(event["event_type"]);
      const counts = countsBySession.get(sessionId) ?? {};
      counts[type] = (counts[type] ?? 0) + 1;
      countsBySession.set(sessionId, counts);
    }
    const header = [
      "actor_user_id",
      "status",
      "started_at",
      "last_activity_at",
      "onboarding_status",
      "question_count",
      "recording_status",
      "feedback_status",
      "error_count",
      "event_count",
    ];
    const lines = [header.map(csvCell).join(",")];
    for (const session of rows.sessions) {
      const actor = String(session["actor_user_id"]);
      const count = Object.values(countsBySession.get(String(session["id"])) ?? {}).reduce(
        (sum, value) => sum + value,
        0,
      );
      lines.push(
        [
          actor,
          session["status"],
          session["started_at"],
          session["last_activity_at"],
          session["onboarding_status"],
          session["question_count"],
          session["recording_status"],
          session["feedback_status"],
          session["error_count"],
          count,
        ]
          .map(csvCell)
          .join(","),
      );
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="jack-pilot-${scope.pilotId}-report.csv"`,
    );
    res.setHeader("Cache-Control", "no-store");
    return res.send(`${lines.join("\r\n")}\r\n`);
  } catch (error) {
    req.log.error({ err: error }, "Could not export pilot report CSV");
    return res.status(503).json({ error: "Pilot CSV export could not be generated." });
  }
});

router.post("/testing/reports/generate", async (req, res) => {
  try {
    const scope = await requireReportScope(req, res, "pilot_report_manual_generation");
    if (!scope) return;
    if (
      !req.body ||
      typeof req.body !== "object" ||
      Array.isArray(req.body) ||
      Object.keys(req.body).some((key) => key !== "reportType") ||
      req.body.reportType !== "pilot_summary"
    ) {
      return res.status(400).json({ error: "Invalid report request." });
    }
    const rows = await loadScopeRows(scope);
    const snapshot = buildSummary(rows.sessions, rows.events, rows.feedback, rows.failures);
    const now = new Date();
    const retainedUntil = new Date(now);
    retainedUntil.setUTCMonth(retainedUntil.getUTCMonth() + 12);
    const report = await db
      .from("activity_report_runs")
      .insert({
        id: randomUUID(),
        organization_id: scope.organizationId,
        pilot_id: scope.pilotId,
        requested_by_user_id: scope.userId,
        report_type: "pilot_summary",
        status: "completed",
        parameters: {},
        aggregate_snapshot: snapshot,
        generated_at: now.toISOString(),
        retained_until: retainedUntil.toISOString(),
      })
      .select("*")
      .single();
    if (report.error) throw report.error;
    return res.status(201).json({
      id: report.data.id,
      status: report.data.status,
      generatedAt: report.data.generated_at,
      retainedUntil: report.data.retained_until,
      summary: snapshot,
    });
  } catch (error) {
    req.log.error({ err: error }, "Could not persist manual pilot report");
    return res.status(503).json({ error: "Manual pilot report could not be generated." });
  }
});

export default router;
