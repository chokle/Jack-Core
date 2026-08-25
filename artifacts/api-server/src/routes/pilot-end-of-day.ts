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
  requestIdentifier,
} from "../lib/activity-telemetry.js";

const router = Router();
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface AuthorizedScope {
  userId: string;
  organizationId: string;
  pilotId: string;
  authority: "pilot_admin" | "organization_admin" | "platform_superadmin";
}

async function requireReportScope(
  req: Request,
  res: Response,
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
  ) {
    return null;
  }

  const organizationId =
    typeof req.query["organizationId"] === "string" ? req.query["organizationId"] : "";
  const pilotId = typeof req.query["pilotId"] === "string" ? req.query["pilotId"] : "";
  const authorization = await authorizeReportScope(identity.userId, organizationId, pilotId);

  await auditReportAccess({
    userId: identity.userId,
    targetUserId: null,
    organizationId: UUID_RE.test(organizationId) ? organizationId : null,
    pilotId: UUID_RE.test(pilotId) ? pilotId : null,
    action: "pilot_end_of_day_report",
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

function utcDayWindow(value: unknown): { start: string; end: string } | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const start = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(start.getTime()) || start.toISOString().slice(0, 10) !== value) {
    return null;
  }

  const requestedEndMs = start.getTime() + 86_400_000;
  const effectiveEndMs = Math.min(requestedEndMs, Date.now());
  if (effectiveEndMs <= start.getTime()) return null;

  return {
    start: start.toISOString(),
    end: new Date(effectiveEndMs).toISOString(),
  };
}

async function loadRows(scope: AuthorizedScope, windowStart: string, windowEnd: string) {
  const [memberships, sessions, events, feedback, failures] = await Promise.all([
    db
      .from("pilot_memberships")
      .select("user_id,role,active,valid_from,valid_until")
      .eq("organization_id", scope.organizationId)
      .eq("pilot_id", scope.pilotId)
      .eq("role", "tester"),
    db
      .from("test_sessions")
      .select("*")
      .eq("organization_id", scope.organizationId)
      .eq("pilot_id", scope.pilotId)
      .gte("last_activity_at", windowStart)
      .lt("started_at", windowEnd),
    db
      .from("test_events")
      .select("*")
      .eq("organization_id", scope.organizationId)
      .eq("pilot_id", scope.pilotId)
      .gte("occurred_at", windowStart)
      .lt("occurred_at", windowEnd)
      .order("occurred_at", { ascending: true }),
    db
      .from("test_feedback")
      .select("*")
      .eq("organization_id", scope.organizationId)
      .eq("pilot_id", scope.pilotId)
      .gte("created_at", windowStart)
      .lt("created_at", windowEnd),
    db
      .from("activity_ingest_failures")
      .select("*")
      .eq("organization_id", scope.organizationId)
      .eq("pilot_id", scope.pilotId)
      .gte("created_at", windowStart)
      .lt("created_at", windowEnd),
  ]);

  const failed = [memberships, sessions, events, feedback, failures].find((result) => result.error);
  if (failed?.error) throw failed.error;

  const startMs = Date.parse(windowStart);
  const endMs = Date.parse(windowEnd);
  return {
    memberships: (memberships.data ?? []).filter((row: Record<string, unknown>) => {
      const validFrom = Date.parse(String(row["valid_from"] ?? ""));
      const validUntil = row["valid_until"]
        ? Date.parse(String(row["valid_until"]))
        : Infinity;
      return (!Number.isFinite(validFrom) || validFrom < endMs) && validUntil > startMs;
    }) as Array<Record<string, unknown>>,
    sessions: (sessions.data ?? []) as Array<Record<string, unknown>>,
    events: (events.data ?? []) as Array<Record<string, unknown>>,
    feedback: (feedback.data ?? []) as Array<Record<string, unknown>>,
    failures: (failures.data ?? []) as Array<Record<string, unknown>>,
  };
}

router.get("/testing/reports/end-of-day", async (req, res) => {
  try {
    const scope = await requireReportScope(req, res);
    if (!scope) return;

    const window = utcDayWindow(req.query["date"]);
    if (!window) {
      return res.status(400).json({ error: "A valid current or past UTC report date is required." });
    }

    const rows = await loadRows(scope, window.start, window.end);
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

export default router;
