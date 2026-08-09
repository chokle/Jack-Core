import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { resolveIdentity } from "../lib/admin-auth.js";
import { isPresentationIdentity } from "../lib/identity.js";
import {
  activityDb as db,
  auditReportAccess,
  authorizeReportScope,
  requestIdentifier,
  type PilotScope,
} from "../lib/activity-telemetry.js";

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface AuthorizedScope extends PilotScope {
  authority: "pilot_admin" | "organization_admin" | "platform_superadmin";
  userId: string;
}

async function requireScope(
  req: Request,
  res: Response,
  action: string,
): Promise<AuthorizedScope | null> {
  const identity = await resolveIdentity(req);
  if (!identity) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  if (isPresentationIdentity(identity)) {
    res.status(403).json({ error: "Command Centre is unavailable in presentation mode." });
    return null;
  }
  const organizationId = typeof req.query.organizationId === "string" ? req.query.organizationId : "";
  const pilotId = typeof req.query.pilotId === "string" ? req.query.pilotId : "";
  const authorization = await authorizeReportScope(identity.userId, organizationId, pilotId);
  await auditReportAccess({
    userId: identity.userId,
    targetUserId: null,
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

// GET /pilots/command-centre/monitor
router.get("/pilots/command-centre/monitor", async (req, res) => {
  try {
    const scope = await requireScope(req, res, "command_centre_monitor");
    if (!scope) return;
    const { organizationId: oid, pilotId: pid } = scope;

    const cached = await db
      .from("pilot_monitor_state")
      .select("*")
      .eq("organization_id", oid)
      .eq("pilot_id", pid)
      .maybeSingle();

    if (cached.data && !cached.error) {
      const age = Date.now() - new Date(cached.data.snapshot_at).getTime();
      if (age < 30000) {
        const row = mapMonitorRow(cached.data);
        return res.json({
          status: row.criticalAlerts > 0 ? "critical" : row.openAlerts > 0 ? "warning" : "healthy",
          timestamp: cached.data.snapshot_at,
          stats: {
            activeSessions: row.activeSessions,
            totalQuestions: row.totalQuestions,
            avgConfidence: 0.85,
            errorRate: row.totalQuestions > 0 ? row.failedResponses / row.totalQuestions : 0,
            totalSites: Object.keys(row.activityBySite ?? {}).length,
            activeTrades: Object.keys(row.activityByTrade ?? {}).length,
          },
          recentQuestions: (row.recentQuestions as Array<Record<string, unknown>> ?? []).map((e) => ({
            id: String(e.eventId ?? randomUUID()),
            question: String((e.metadata as Record<string, unknown>)?.question ?? "Query"),
            status: String(e.result ?? "completed"),
            confidence: Number((e.metadata as Record<string, unknown>)?.confidence ?? 0.85),
            askedAt: String(e.occurredAt ?? cached.data.snapshot_at),
            site: String((e.metadata as Record<string, unknown>)?.site ?? "Main Site"),
            trade: String((e.metadata as Record<string, unknown>)?.trade ?? "General"),
            role: String((e.metadata as Record<string, unknown>)?.role ?? "Worker"),
          })),
          siteBreakdown: Object.entries(row.activityBySite ?? {}).map(([name, count]) => ({ name, count: Number(count), active: Number(count) })),
          tradeBreakdown: Object.entries(row.activityByTrade ?? {}).map(([name, count]) => ({ name, count: Number(count), active: Number(count) })),
          roleBreakdown: Object.entries(row.activityByRole ?? {}).map(([name, count]) => ({ name, count: Number(count), active: Number(count) })),
          monitor: row,
          cached: true,
          snapshotAt: cached.data.snapshot_at,
        });
      }
    }

    const now = new Date().toISOString();
    const sinceMidnight = new Date();
    sinceMidnight.setUTCHours(0, 0, 0, 0);
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const todayStr = sinceMidnight.toISOString();
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    const [sessions, events, feedback, failures, alerts, contributions] = await Promise.all([
      db.from("test_sessions").select("*").eq("organization_id", oid).eq("pilot_id", pid),
      db.from("test_events").select("*").eq("organization_id", oid).eq("pilot_id", pid),
      db.from("test_feedback").select("*").eq("organization_id", oid).eq("pilot_id", pid),
      db.from("activity_ingest_failures").select("*").eq("organization_id", oid).eq("pilot_id", pid),
      db.from("pilot_health_alerts").select("*").eq("organization_id", oid).eq("pilot_id", pid),
      db.from("pilot_knowledge_contributions").select("*").eq("organization_id", oid).eq("pilot_id", pid).gte("created_at", yesterday),
    ]);

    for (const r of [sessions, events, feedback, failures, alerts, contributions]) {
      if (r.error) throw r.error;
    }

    const sessionList = (sessions.data ?? []) as Record<string, unknown>[];
    const eventList = (events.data ?? []) as Record<string, unknown>[];
    const feedbackList = (feedback.data ?? []) as Record<string, unknown>[];
    const failureList = (failures.data ?? []) as Record<string, unknown>[];
    const alertList = (alerts.data ?? []) as Record<string, unknown>[];
    const contribList = (contributions.data ?? []) as Record<string, unknown>[];

    const activeUsers = new Set(sessionList.filter((s) => s.status === "active").map((s) => String(s.actor_user_id)));
    const todaysEvents = eventList.filter((e) => String(e.occurred_at ?? "") >= todayStr);
    const recentUsers = new Set(
      eventList.filter((e) => String(e.occurred_at ?? "") >= fiveMinAgo).map((e) => String(e.actor_user_id))
    );
    const questions = todaysEvents.filter((e) => e.event_type === "ask_jack_completed");
    const failedQ = todaysEvents.filter((e) => e.event_type === "ask_jack_failed");
    const usefulFeed = feedbackList.filter(
      (f) => String(f.created_at ?? "") >= todayStr && (f.usefulness === "yes" || f.usefulness === "useful")
    );
    const notUsefulFeed = feedbackList.filter(
      (f) => String(f.created_at ?? "") >= todayStr && (f.usefulness === "no" || f.usefulness === "partly" || f.usefulness === "not_useful")
    );
    const citationEvents = todaysEvents.filter(
      (e) => e.event_type === "citation_opened" || e.event_type === "citation_verified"
    );
    const loginFailures = failureList.filter(
      (f) => f.reason_code === "login_failure" && String(f.created_at ?? "") >= yesterday
    );
    const sessionFailures = failureList.filter(
      (f) => f.reason_code === "session_failure" && String(f.created_at ?? "") >= yesterday
    );
    const dupEvents24h = failureList.filter(
      (f) => f.reason_code === "duplicate_event" && String(f.created_at ?? "") >= yesterday
    );

    const flaggedAll = todaysEvents.filter((e) => {
      const meta = e.metadata as Record<string, unknown> | undefined;
      return meta?.flagged === true;
    });

    const siteMap: Record<string, { total: number; active: number }> = {};
    const tradeMap: Record<string, { total: number; active: number }> = {};
    const roleMap: Record<string, { total: number; active: number }> = {};

    for (const session of sessionList) {
      const role = String(session.role ?? "unknown");
      const trade = String(session.trade ?? "unknown");
      const site = String(session.site ?? "unknown");
      const isActive = session.status === "active";

      if (!siteMap[site]) siteMap[site] = { total: 0, active: 0 };
      siteMap[site].total += 1;
      if (isActive) siteMap[site].active += 1;

      if (!tradeMap[trade]) tradeMap[trade] = { total: 0, active: 0 };
      tradeMap[trade].total += 1;
      if (isActive) tradeMap[trade].active += 1;

      if (!roleMap[role]) roleMap[role] = { total: 0, active: 0 };
      roleMap[role].total += 1;
      if (isActive) roleMap[role].active += 1;
    }

    const byRole: Record<string, number> = {};
    const byTrade: Record<string, number> = {};
    const bySite: Record<string, number> = {};
    for (const [k, v] of Object.entries(roleMap)) byRole[k] = v.active;
    for (const [k, v] of Object.entries(tradeMap)) byTrade[k] = v.active;
    for (const [k, v] of Object.entries(siteMap)) bySite[k] = v.active;

    const recentQ = todaysEvents
      .filter((e) => e.event_type === "ask_jack_completed" || e.event_type === "ask_jack_failed")
      .sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)))
      .slice(0, 20)
      .map((e) => ({
        eventId: e.event_id,
        eventType: e.event_type,
        occurredAt: e.occurred_at,
        actorUserId: e.actor_user_id,
        result: e.result,
        metadata: (e.metadata as Record<string, unknown>) ?? {},
      }));

    const latencies: number[] = [];
    for (const ev of todaysEvents) {
      const meta = ev.metadata as Record<string, unknown> | undefined;
      if (meta && typeof meta.latency_ms === "number") latencies.push(meta.latency_ms);
    }
    const avgLat = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
    const sortedLat = [...latencies].sort((a, b) => a - b);
    const p95Lat = sortedLat.length > 0 ? sortedLat[Math.floor(sortedLat.length * 0.95)] : 0;

    const snapshot = {
      activeUsersNow: activeUsers.size,
      recentlyActiveUsers: recentUsers.size,
      activeSessions: sessionList.filter((s) => s.status === "active").length,
      todaysSessions: sessionList.filter((s) => String(s.started_at) >= todayStr).length,
      totalQuestions: questions.length,
      successfulResponses: questions.length,
      failedResponses: failedQ.length,
      avgResponseLatencyMs: Math.round(avgLat * 100) / 100,
      p95ResponseLatencyMs: Math.round(p95Lat * 100) / 100,
      totalFeedback: feedbackList.filter((f) => String(f.created_at) >= todayStr).length,
      usefulCount: usefulFeed.length,
      notUsefulCount: notUsefulFeed.length,
      accuracyAvg: 0,
      citationCount: citationEvents.length,
      citationOpens: citationEvents.filter((e) => e.event_type === "citation_opened").length,
      citationVerifications: citationEvents.filter((e) => e.event_type === "citation_verified").length,
      openAlerts: alertList.filter((a) => a.status === "open" || a.status === "acknowledged" || a.status === "in_progress").length,
      criticalAlerts: alertList.filter(
        (a) => a.severity === "critical" && (a.status === "open" || a.status === "acknowledged" || a.status === "in_progress")
      ).length,
      ingestionHealthy:
        failureList.filter((f) => f.reason_code === "ingestion_failure" && String(f.created_at) >= yesterday).length === 0,
      lastIngestionAt: now,
      loginFailures24h: loginFailures.length,
      sessionFailures24h: sessionFailures.length,
      duplicateEvents24h: dupEvents24h.length,
      knowledgeContributions24h: contribList.length,
      flaggedLowConfidence: flaggedAll.slice(0, 10).map((e) => ({
        eventId: e.event_id,
        actorUserId: e.actor_user_id,
        occurredAt: e.occurred_at,
      })),
      recentQuestions: recentQ,
      activityBySite: bySite,
      activityByTrade: byTrade,
      activityByRole: byRole,
    };

    try {
      await db
        .from("pilot_monitor_state")
        .upsert({
          organization_id: oid,
          pilot_id: pid,
          ...toSnakeCase(snapshot),
          snapshot_at: now,
          updated_at: now,
        })
        .select("*")
        .single();
    } catch (_cacheError) {
      req.log.warn({ err: _cacheError }, "Could not cache monitor snapshot");
    }

    const totalQ = questions.length + failedQ.length;
    const siteBreakdown = Object.entries(siteMap).map(([name, val]) => ({ name, count: val.total, active: val.active }));
    const tradeBreakdown = Object.entries(tradeMap).map(([name, val]) => ({ name, count: val.total, active: val.active }));
    const roleBreakdown = Object.entries(roleMap).map(([name, val]) => ({ name, count: val.total, active: val.active }));

    const overallStatus =
      snapshot.criticalAlerts > 0 ? "critical" : snapshot.openAlerts > 0 ? "warning" : "healthy";

    return res.json({
      status: overallStatus,
      timestamp: now,
      stats: {
        activeSessions: snapshot.activeSessions,
        totalQuestions: totalQ,
        avgConfidence: 0.85,
        errorRate: totalQ > 0 ? failedQ.length / totalQ : 0,
        totalSites: siteBreakdown.length,
        activeTrades: tradeBreakdown.filter((t) => t.active > 0).length,
      },
      recentQuestions: recentQ.map((e) => ({
        id: String(e.eventId ?? randomUUID()),
        question: String((e.metadata as Record<string, unknown>)?.question ?? "Query"),
        status: String(e.result ?? "completed"),
        confidence: Number((e.metadata as Record<string, unknown>)?.confidence ?? 0.85),
        askedAt: String(e.occurredAt ?? now),
        site: String((e.metadata as Record<string, unknown>)?.site ?? "Main Site"),
        trade: String((e.metadata as Record<string, unknown>)?.trade ?? "General"),
        role: String((e.metadata as Record<string, unknown>)?.role ?? "Worker"),
      })),
      siteBreakdown,
      tradeBreakdown,
      roleBreakdown,
      monitor: snapshot,
      cached: false,
      snapshotAt: now,
    });
  } catch (error) {
    req.log.error({ err: error }, "Could not build Command Centre monitor");
    return res.status(503).json({ error: "Live monitor could not be generated." });
  }
});

// GET /pilots/command-centre/alerts
router.get("/pilots/command-centre/alerts", async (req, res) => {
  try {
    const scope = await requireScope(req, res, "command_centre_alerts_list");
    if (!scope) return;
    const { organizationId: oid, pilotId: pid } = scope;

    let query = db.from("pilot_health_alerts").select("*").eq("organization_id", oid).eq("pilot_id", pid);

    if (typeof req.query.status === "string" && req.query.status) {
      query = query.eq("status", req.query.status);
    }
    if (typeof req.query.severity === "string" && req.query.severity) {
      query = query.eq("severity", req.query.severity);
    }

    const result = await query.order("created_at", { ascending: false }).limit(100);
    if (result.error) throw result.error;
    return res.json({ alerts: (result.data ?? []).map(mapAlertRow), total: (result.data ?? []).length });
  } catch (error) {
    req.log.error({ err: error }, "Could not list health alerts");
    return res.status(503).json({ error: "Health alerts could not be retrieved." });
  }
});

// POST /pilots/command-centre/alerts
router.post("/pilots/command-centre/alerts", async (req, res) => {
  try {
    const scope = await requireScope(req, res, "command_centre_alerts_create");
    if (!scope) return;
    const { organizationId: oid, pilotId: pid } = scope;
    const body = req.body ?? {};
    const alertType = typeof body.alertType === "string" && body.alertType ? body.alertType : "custom";
    const required = ["severity", "title"];
    for (const field of required) {
      if (typeof body[field] !== "string" || !body[field]) {
        return res.status(400).json({ error: `Missing required field: ${field}` });
      }
    }
    const VALID_TYPES = new Set([
      "no_activity_48h",
      "activation_below_target",
      "weekly_active_users_below_target",
      "repeated_login_failures",
      "repeated_session_failures",
      "telemetry_ingestion_failure",
      "duplicate_event_spike",
      "low_usefulness_ratings",
      "low_accuracy_ratings",
      "repeated_flagged_answers",
      "low_confidence_safety_answer",
      "repeated_unanswered_plumbing",
      "privacy_scope_integrity_violation",
      "single_active_user",
      "sharp_usage_decline",
      "missing_session_records",
      "custom",
    ]);
    const VALID_SEVERITIES = new Set(["critical", "high", "medium", "low", "info", "warning"]);
    if (!VALID_TYPES.has(alertType)) return res.status(400).json({ error: `Invalid alert type` });
    if (!VALID_SEVERITIES.has(body.severity)) return res.status(400).json({ error: `Invalid severity` });

    const dbSeverity = body.severity === "warning" ? "high" : body.severity;

    const row = await db
      .from("pilot_health_alerts")
      .insert({
        id: randomUUID(),
        organization_id: oid,
        pilot_id: pid,
        alert_type: alertType,
        severity: dbSeverity,
        title: body.title,
        description: body.description ?? null,
        trigger_event: body.triggerEvent ?? null,
        trigger_details: body.triggerDetails ?? {},
        relevant_evidence: body.relevantEvidence ?? [],
        recommended_action: body.recommendedAction ?? null,
        responsible_owner: body.responsibleOwner ?? null,
        status: "open",
        status_history: [{ status: "open", at: new Date().toISOString(), by: scope.userId }],
      })
      .select("*")
      .single();
    if (row.error) throw row.error;
    const mapped = mapAlertRow(row.data);
    return res.status(201).json({ alert: mapped, ...mapped });
  } catch (error) {
    req.log.error({ err: error }, "Could not create health alert");
    return res.status(503).json({ error: "Health alert could not be created." });
  }
});

// PATCH /pilots/command-centre/alerts/:id
router.patch("/pilots/command-centre/alerts/:id", async (req, res) => {
  try {
    const scope = await requireScope(req, res, "command_centre_alerts_update");
    if (!scope) return;
    const { organizationId: oid, pilotId: pid } = scope;
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: "Invalid alert ID." });

    const existing = await db
      .from("pilot_health_alerts")
      .select("*")
      .eq("id", req.params.id)
      .eq("organization_id", oid)
      .eq("pilot_id", pid)
      .maybeSingle();
    if (existing.error) throw existing.error;
    if (!existing.data) return res.status(404).json({ error: "Alert not found." });

    const body = req.body ?? {};
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.status && typeof body.status === "string") {
      const valid = new Set(["open", "acknowledged", "in_progress", "resolved", "dismissed", "escalated"]);
      if (!valid.has(body.status)) return res.status(400).json({ error: "Invalid status." });
      update.status = body.status;
      if (body.status === "acknowledged") {
        update.acknowledged_by = scope.userId;
        update.acknowledged_at = new Date().toISOString();
      }
      if (body.status === "resolved") {
        update.resolved_by = scope.userId;
        update.resolved_at = new Date().toISOString();
      }
      const history = Array.isArray(existing.data.status_history) ? existing.data.status_history : [];
      history.push({ status: body.status, at: new Date().toISOString(), by: scope.userId });
      update.status_history = history;
    }
    if (body.severity) update.severity = body.severity === "warning" ? "high" : body.severity;
    if (body.description) update.description = body.description;
    if (body.recommendedAction) update.recommended_action = body.recommendedAction;
    if (body.responsibleOwner) update.responsible_owner = body.responsibleOwner;
    if (body.relevantEvidence) update.relevant_evidence = body.relevantEvidence;

    const updated = await db
      .from("pilot_health_alerts")
      .update(update)
      .eq("id", req.params.id)
      .eq("organization_id", oid)
      .eq("pilot_id", pid)
      .select("*")
      .single();
    if (updated.error || !updated.data) return res.status(404).json({ error: "Alert not found." });
    const mapped = mapAlertRow(updated.data);
    return res.json({ alert: mapped, ...mapped });
  } catch (error) {
    req.log.error({ err: error }, "Could not update health alert");
    return res.status(503).json({ error: "Health alert could not be updated." });
  }
});

// GET /pilots/command-centre/evidence
router.get("/pilots/command-centre/evidence", async (req, res) => {
  try {
    const scope = await requireScope(req, res, "command_centre_evidence_list");
    if (!scope) return;
    const { organizationId: oid, pilotId: pid } = scope;
    let query = db.from("pilot_evidence").select("*").eq("organization_id", oid).eq("pilot_id", pid);

    const evidenceTypeFilter =
      typeof req.query.evidenceType === "string" && req.query.evidenceType
        ? req.query.evidenceType
        : typeof req.query.type === "string" && req.query.type !== "all"
        ? req.query.type === "observation" || req.query.type === "measurement" || req.query.type === "test_result"
          ? "metric"
          : req.query.type
        : "";
    if (evidenceTypeFilter) query = query.eq("evidence_type", evidenceTypeFilter);

    const validationStatusFilter =
      typeof req.query.validationStatus === "string" && req.query.validationStatus
        ? req.query.validationStatus
        : typeof req.query.validation === "string" && req.query.validation !== "all"
        ? req.query.validation === "pending"
          ? "unvalidated"
          : req.query.validation === "invalid"
          ? "rejected"
          : req.query.validation
        : "";
    if (validationStatusFilter) query = query.eq("validation_status", validationStatusFilter);

    const result = await query.order("created_at", { ascending: false }).limit(200);
    if (result.error) throw result.error;
    return res.json({ evidence: (result.data ?? []).map(mapEvidenceRow), total: (result.data ?? []).length });
  } catch (error) {
    req.log.error({ err: error }, "Could not list evidence");
    return res.status(503).json({ error: "Evidence could not be retrieved." });
  }
});

// POST /pilots/command-centre/evidence
router.post("/pilots/command-centre/evidence", async (req, res) => {
  try {
    const scope = await requireScope(req, res, "command_centre_evidence_create");
    if (!scope) return;
    const { organizationId: oid, pilotId: pid } = scope;
    const body = req.body ?? {};

    const rawType = body.evidenceType ?? body.type;
    const rawTitle = body.title ?? body.summary;

    if (typeof rawType !== "string" || !rawType) return res.status(400).json({ error: "Missing evidenceType" });
    if (typeof rawTitle !== "string" || !rawTitle) return res.status(400).json({ error: "Missing title" });

    let evidenceType = rawType;
    if (rawType === "observation" || rawType === "measurement" || rawType === "test_result" || rawType === "system_event") {
      evidenceType = "metric";
    } else if (rawType === "user_feedback") {
      evidenceType = "quote";
    }

    const validTypes = new Set([
      "metric",
      "quote",
      "screenshot",
      "story",
      "correction",
      "knowledge_contribution",
      "safety_quality_evidence",
      "commercial_evidence",
    ]);
    if (!validTypes.has(evidenceType)) return res.status(400).json({ error: "Invalid evidence type." });

    const row = await db
      .from("pilot_evidence")
      .insert({
        id: randomUUID(),
        organization_id: oid,
        pilot_id: pid,
        actor_user_id: scope.userId,
        session_id: body.sessionId ?? null,
        evidence_type: evidenceType,
        title: rawTitle,
        description: body.description ?? body.summary ?? null,
        person_identifier: body.personIdentifier ?? null,
        role: body.role ?? null,
        trade: body.trade ?? null,
        exact_quote: body.exactQuote ?? null,
        metric_supported: body.metricSupported ?? null,
        consent_status: body.consentStatus ?? "not_applicable",
        supporting_file_url: body.supportingFileUrl ?? null,
        supporting_url: body.supportingUrl ?? null,
        validation_status: "unvalidated",
        event_id: body.eventId ?? null,
      })
      .select("*")
      .single();
    if (row.error) throw row.error;
    const mapped = mapEvidenceRow(row.data);
    return res.status(201).json({ evidence: mapped, ...mapped });
  } catch (error) {
    req.log.error({ err: error }, "Could not create evidence");
    return res.status(503).json({ error: "Evidence could not be created." });
  }
});

// PATCH /pilots/command-centre/evidence/:id
router.patch("/pilots/command-centre/evidence/:id", async (req, res) => {
  try {
    const scope = await requireScope(req, res, "command_centre_evidence_update");
    if (!scope) return;
    const { organizationId: oid, pilotId: pid } = scope;
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: "Invalid evidence ID." });
    const existing = await db
      .from("pilot_evidence")
      .select("*")
      .eq("id", req.params.id)
      .eq("organization_id", oid)
      .eq("pilot_id", pid)
      .maybeSingle();
    if (existing.error) throw existing.error;
    if (!existing.data) return res.status(404).json({ error: "Evidence not found." });
    const body = req.body ?? {};
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.validationStatus || body.status) {
      let valStatus = body.validationStatus ?? body.status;
      if (valStatus === "invalid" || valStatus === "rejected") valStatus = "rejected";
      else if (valStatus === "pending") valStatus = "unvalidated";
      const valid = new Set(["unvalidated", "validated", "disputed", "rejected"]);
      if (!valid.has(valStatus)) return res.status(400).json({ error: "Invalid validation status." });
      update.validation_status = valStatus;
      update.validated_by = scope.userId;
      update.validated_at = new Date().toISOString();
    }
    if (body.followUpOwner) update.follow_up_owner = body.followUpOwner;
    if (body.description) update.description = body.description;
    if (body.consentStatus) update.consent_status = body.consentStatus;
    const updated = await db
      .from("pilot_evidence")
      .update(update)
      .eq("id", req.params.id)
      .eq("organization_id", oid)
      .eq("pilot_id", pid)
      .select("*")
      .single();
    if (updated.error || !updated.data) return res.status(404).json({ error: "Evidence not found." });
    const mapped = mapEvidenceRow(updated.data);
    return res.json({ evidence: mapped, ...mapped });
  } catch (error) {
    req.log.error({ err: error }, "Could not update evidence");
    return res.status(503).json({ error: "Evidence could not be updated." });
  }
});

// GET /pilots/command-centre/knowledge
router.get("/pilots/command-centre/knowledge", async (req, res) => {
  try {
    const scope = await requireScope(req, res, "command_centre_knowledge_list");
    if (!scope) return;
    const { organizationId: oid, pilotId: pid } = scope;
    let query = db.from("pilot_knowledge_contributions").select("*").eq("organization_id", oid).eq("pilot_id", pid);
    let statusFilter =
      typeof req.query.status === "string"
        ? req.query.status
        : typeof req.query.validationStatus === "string"
        ? req.query.validationStatus
        : "";
    if (statusFilter === "approved") statusFilter = "accepted";
    if (statusFilter === "merged") statusFilter = "incorporated";

    if (statusFilter && statusFilter !== "all") query = query.eq("validation_status", statusFilter);
    const result = await query.order("created_at", { ascending: false }).limit(200);
    if (result.error) throw result.error;
    return res.json({ contributions: (result.data ?? []).map(mapKnowledgeRow), total: (result.data ?? []).length });
  } catch (error) {
    req.log.error({ err: error }, "Could not list knowledge contributions");
    return res.status(503).json({ error: "Knowledge contributions could not be retrieved." });
  }
});

// GET /pilots/command-centre/export
router.get("/pilots/command-centre/export", async (req, res) => {
  try {
    const scope = await requireScope(req, res, "command_centre_export");
    if (!scope) return;
    const { organizationId: oid, pilotId: pid } = scope;
    const format = typeof req.query.format === "string" ? req.query.format : "json";

    const [sessions, events, feedback, failures, alerts, evidence, contributions] = await Promise.all([
      db.from("test_sessions").select("*").eq("organization_id", oid).eq("pilot_id", pid),
      db.from("test_events").select("*").eq("organization_id", oid).eq("pilot_id", pid),
      db.from("test_feedback").select("*").eq("organization_id", oid).eq("pilot_id", pid),
      db.from("activity_ingest_failures").select("*").eq("organization_id", oid).eq("pilot_id", pid),
      db.from("pilot_health_alerts").select("*").eq("organization_id", oid).eq("pilot_id", pid),
      db.from("pilot_evidence").select("*").eq("organization_id", oid).eq("pilot_id", pid),
      db.from("pilot_knowledge_contributions").select("*").eq("organization_id", oid).eq("pilot_id", pid),
    ]);
    for (const r of [sessions, events, feedback, failures, alerts, evidence, contributions]) {
      if (r.error) throw r.error;
    }

    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="jack-pilot-${pid}-export.csv"`);
      res.setHeader("Cache-Control", "no-store");
      const rows = (events.data ?? []) as Record<string, unknown>[];
      const header = ["event_id", "event_type", "occurred_at", "actor_user_id", "organization_id", "pilot_id", "test_session_id", "surface", "result"];
      const lines = [header.join(",")];
      for (const row of rows) {
        lines.push(
          header
            .map((h) => {
              const val = row[h] ?? "";
              const s = String(val).replace(/"/g, '""');
              return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s}"` : s;
            })
            .join(",")
        );
      }
      return res.send(`${lines.join("\r\n")}\r\n`);
    }

    res.setHeader("Content-Disposition", `attachment; filename="jack-pilot-${pid}-export.json"`);
    res.setHeader("Cache-Control", "no-store");
    return res.json({
      exportedAt: new Date().toISOString(),
      organizationId: oid,
      pilotId: pid,
      sessions: sessions.data ?? [],
      events: events.data ?? [],
      feedback: feedback.data ?? [],
      ingestionFailures: failures.data ?? [],
      healthAlerts: alerts.data ?? [],
      evidence: evidence.data ?? [],
      knowledgeContributions: contributions.data ?? [],
    });
  } catch (error) {
    req.log.error({ err: error }, "Could not export pilot data");
    return res.status(503).json({ error: "Pilot data export could not be generated." });
  }
});

// POST /pilots/command-centre/alerts/auto-detect
router.post("/pilots/command-centre/alerts/auto-detect", async (req, res) => {
  try {
    const scope = await requireScope(req, res, "command_centre_alerts_auto_detect");
    if (!scope) return;
    const { organizationId: oid, pilotId: pid } = scope;

    const now = new Date().toISOString();
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const generated: Array<{ alertType: string; severity: string; title: string; details: Record<string, unknown> }> = [];

    const recentEvents = await db
      .from("test_events")
      .select("occurred_at", { count: "exact", head: true })
      .eq("organization_id", oid)
      .eq("pilot_id", pid)
      .gte("occurred_at", twoDaysAgo);
    if (recentEvents.count === 0) {
      generated.push({ alertType: "no_activity_48h", severity: "high", title: "No pilot activity for 48 hours", details: { since: twoDaysAgo } });
    }

    const loginFailures = await db
      .from("activity_ingest_failures")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", oid)
      .eq("pilot_id", pid)
      .eq("reason_code", "login_failure")
      .gte("created_at", yesterday);
    if ((loginFailures.count ?? 0) >= 5) {
      generated.push({ alertType: "repeated_login_failures", severity: "high", title: "Repeated login failures", details: { count: loginFailures.count } });
    }

    const ingestFailures = await db
      .from("activity_ingest_failures")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", oid)
      .eq("pilot_id", pid)
      .eq("reason_code", "ingestion_failure")
      .gte("created_at", yesterday);
    if ((ingestFailures.count ?? 0) >= 3) {
      generated.push({ alertType: "telemetry_ingestion_failure", severity: "critical", title: "Telemetry ingestion failures", details: { count: ingestFailures.count } });
    }

    const recentFeedback = await db
      .from("test_feedback")
      .select("*")
      .eq("organization_id", oid)
      .eq("pilot_id", pid)
      .gte("created_at", sevenDaysAgo);
    if (!recentFeedback.error && Array.isArray(recentFeedback.data)) {
      const total = recentFeedback.data.length;
      if (total >= 5) {
        const notUseful = recentFeedback.data.filter((f: Record<string, unknown>) => f.usefulness === "no" || f.usefulness === "partly").length;
        if (notUseful / total > 0.5) {
          generated.push({ alertType: "low_usefulness_ratings", severity: "medium", title: "Low usefulness ratings", details: { notUseful, total } });
        }
      }
    }

    const dupEvents = await db
      .from("activity_ingest_failures")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", oid)
      .eq("pilot_id", pid)
      .eq("reason_code", "duplicate_event")
      .gte("created_at", yesterday);
    if ((dupEvents.count ?? 0) >= 10) {
      generated.push({ alertType: "duplicate_event_spike", severity: "medium", title: "Duplicate event spike", details: { count: dupEvents.count } });
    }

    const sessionFailures = await db
      .from("activity_ingest_failures")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", oid)
      .eq("pilot_id", pid)
      .eq("reason_code", "session_failure")
      .gte("created_at", yesterday);
    if ((sessionFailures.count ?? 0) >= 5) {
      generated.push({ alertType: "repeated_session_failures", severity: "high", title: "Repeated session failures", details: { count: sessionFailures.count } });
    }

    const activeSessions = await db
      .from("test_sessions")
      .select("actor_user_id")
      .eq("organization_id", oid)
      .eq("pilot_id", pid)
      .eq("status", "active");
    if (!activeSessions.error && Array.isArray(activeSessions.data)) {
      const uniqueUsers = new Set(activeSessions.data.map((s: Record<string, unknown>) => String(s.actor_user_id)));
      if (uniqueUsers.size <= 1) {
        generated.push({ alertType: "single_active_user", severity: "low", title: "Only one active user", details: { userCount: uniqueUsers.size } });
      }
    }

    const created: Array<Record<string, unknown>> = [];
    for (const alert of generated) {
      const existing = await db
        .from("pilot_health_alerts")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", oid)
        .eq("pilot_id", pid)
        .eq("alert_type", alert.alertType)
        .in("status", ["open", "acknowledged", "in_progress"]);
      if ((existing.count ?? 0) > 0) continue;

      const row = await db
        .from("pilot_health_alerts")
        .insert({
          id: randomUUID(),
          organization_id: oid,
          pilot_id: pid,
          alert_type: alert.alertType,
          severity: alert.severity,
          title: alert.title,
          trigger_details: alert.details ?? {},
          status: "open",
          status_history: [{ status: "open", at: now, by: "system" }],
        })
        .select("*")
        .single();
      if (!row.error) created.push(mapAlertRow(row.data));
    }

    return res.json({ created: created.length, alerts: created, generated: created, count: created.length });
  } catch (error) {
    req.log.error({ err: error }, "Could not auto-detect health alerts");
    return res.status(503).json({ error: "Alert auto-detection could not be completed." });
  }
});

// PATCH /pilots/command-centre/alerts/:id/acknowledge
router.patch("/pilots/command-centre/alerts/:id/acknowledge", async (req, res) => {
  try {
    const scope = await requireScope(req, res, "command_centre_alerts_update");
    if (!scope) return;
    const { organizationId: oid, pilotId: pid } = scope;
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: "Invalid alert ID." });
    const existing = await db
      .from("pilot_health_alerts")
      .select("*")
      .eq("id", req.params.id)
      .eq("organization_id", oid)
      .eq("pilot_id", pid)
      .maybeSingle();
    if (existing.error) throw existing.error;
    if (!existing.data) return res.status(404).json({ error: "Alert not found." });
    const history = Array.isArray(existing.data.status_history) ? existing.data.status_history : [];
    history.push({ status: "acknowledged", at: new Date().toISOString(), by: scope.userId });
    const updated = await db
      .from("pilot_health_alerts")
      .update({
        status: "acknowledged",
        acknowledged_by: scope.userId,
        acknowledged_at: new Date().toISOString(),
        status_history: history,
        updated_at: new Date().toISOString(),
      })
      .eq("id", req.params.id)
      .eq("organization_id", oid)
      .eq("pilot_id", pid)
      .select("*")
      .single();
    if (updated.error || !updated.data) return res.status(404).json({ error: "Alert not found." });
    const mapped = mapAlertRow(updated.data);
    return res.json({ alert: mapped, ...mapped });
  } catch (error) {
    req.log.error({ err: error }, "Could not acknowledge health alert");
    return res.status(503).json({ error: "Health alert could not be acknowledged." });
  }
});

// PATCH /pilots/command-centre/alerts/:id/resolve
router.patch("/pilots/command-centre/alerts/:id/resolve", async (req, res) => {
  try {
    const scope = await requireScope(req, res, "command_centre_alerts_update");
    if (!scope) return;
    const { organizationId: oid, pilotId: pid } = scope;
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: "Invalid alert ID." });
    const existing = await db
      .from("pilot_health_alerts")
      .select("*")
      .eq("id", req.params.id)
      .eq("organization_id", oid)
      .eq("pilot_id", pid)
      .maybeSingle();
    if (existing.error) throw existing.error;
    if (!existing.data) return res.status(404).json({ error: "Alert not found." });
    const history = Array.isArray(existing.data.status_history) ? existing.data.status_history : [];
    history.push({ status: "resolved", at: new Date().toISOString(), by: scope.userId });
    const updated = await db
      .from("pilot_health_alerts")
      .update({
        status: "resolved",
        resolved_by: scope.userId,
        resolved_at: new Date().toISOString(),
        status_history: history,
        updated_at: new Date().toISOString(),
      })
      .eq("id", req.params.id)
      .eq("organization_id", oid)
      .eq("pilot_id", pid)
      .select("*")
      .single();
    if (updated.error || !updated.data) return res.status(404).json({ error: "Alert not found." });
    const mapped = mapAlertRow(updated.data);
    return res.json({ alert: mapped, ...mapped });
  } catch (error) {
    req.log.error({ err: error }, "Could not resolve health alert");
    return res.status(503).json({ error: "Health alert could not be resolved." });
  }
});

// PATCH /pilots/command-centre/alerts/:id/dismiss
router.patch("/pilots/command-centre/alerts/:id/dismiss", async (req, res) => {
  try {
    const scope = await requireScope(req, res, "command_centre_alerts_update");
    if (!scope) return;
    const { organizationId: oid, pilotId: pid } = scope;
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: "Invalid alert ID." });
    const existing = await db
      .from("pilot_health_alerts")
      .select("*")
      .eq("id", req.params.id)
      .eq("organization_id", oid)
      .eq("pilot_id", pid)
      .maybeSingle();
    if (existing.error) throw existing.error;
    if (!existing.data) return res.status(404).json({ error: "Alert not found." });
    const history = Array.isArray(existing.data.status_history) ? existing.data.status_history : [];
    history.push({ status: "dismissed", at: new Date().toISOString(), by: scope.userId });
    const updated = await db
      .from("pilot_health_alerts")
      .update({
        status: "dismissed",
        status_history: history,
        updated_at: new Date().toISOString(),
      })
      .eq("id", req.params.id)
      .eq("organization_id", oid)
      .eq("pilot_id", pid)
      .select("*")
      .single();
    if (updated.error || !updated.data) return res.status(404).json({ error: "Alert not found." });
    const mapped = mapAlertRow(updated.data);
    return res.json({ alert: mapped, ...mapped });
  } catch (error) {
    req.log.error({ err: error }, "Could not dismiss health alert");
    return res.status(503).json({ error: "Health alert could not be dismissed." });
  }
});

// PATCH /pilots/command-centre/evidence/:id/validate
router.patch("/pilots/command-centre/evidence/:id/validate", async (req, res) => {
  try {
    const scope = await requireScope(req, res, "command_centre_evidence_update");
    if (!scope) return;
    const { organizationId: oid, pilotId: pid } = scope;
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: "Invalid evidence ID." });
    const body = req.body ?? {};
    let status = body.status === "validated" ? "validated" : "rejected";
    if (body.status === "invalid" || body.status === "rejected") status = "rejected";

    const updated = await db
      .from("pilot_evidence")
      .update({
        validation_status: status,
        validated_by: scope.userId,
        validated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", req.params.id)
      .eq("organization_id", oid)
      .eq("pilot_id", pid)
      .select("*")
      .single();
    if (updated.error || !updated.data) return res.status(404).json({ error: "Evidence not found." });
    const mapped = mapEvidenceRow(updated.data);
    return res.json({ evidence: mapped, ...mapped });
  } catch (error) {
    req.log.error({ err: error }, "Could not validate evidence");
    return res.status(503).json({ error: "Evidence could not be validated." });
  }
});

// Helper mappers
function mapMonitorRow(row: Record<string, unknown>) {
  return {
    activeUsersNow: Number(row.active_users_now ?? 0),
    recentlyActiveUsers: Number(row.recently_active_users ?? 0),
    activeSessions: Number(row.active_sessions ?? 0),
    todaysSessions: Number(row.todays_sessions ?? 0),
    totalQuestions: Number(row.total_questions ?? 0),
    successfulResponses: Number(row.successful_responses ?? 0),
    failedResponses: Number(row.failed_responses ?? 0),
    avgResponseLatencyMs: Number(row.avg_response_latency_ms ?? 0),
    p95ResponseLatencyMs: Number(row.p95_response_latency_ms ?? 0),
    totalFeedback: Number(row.total_feedback ?? 0),
    usefulCount: Number(row.useful_count ?? 0),
    notUsefulCount: Number(row.not_useful_count ?? 0),
    accuracyAvg: Number(row.accuracy_avg ?? 0),
    citationCount: Number(row.citation_count ?? 0),
    citationOpens: Number(row.citation_opens ?? 0),
    citationVerifications: Number(row.citation_verifications ?? 0),
    openAlerts: Number(row.open_alerts ?? 0),
    criticalAlerts: Number(row.critical_alerts ?? 0),
    ingestionHealthy: Boolean(row.ingestion_healthy ?? true),
    lastIngestionAt: row.last_ingestion_at ? String(row.last_ingestion_at) : null,
    loginFailures24h: Number(row.login_failures_24h ?? 0),
    sessionFailures24h: Number(row.session_failures_24h ?? 0),
    duplicateEvents24h: Number(row.duplicate_events_24h ?? 0),
    knowledgeContributions24h: Number(row.knowledge_contributions_24h ?? 0),
    activityBySite: (row.activity_by_site as Record<string, number>) ?? {},
    activityByTrade: (row.activity_by_trade as Record<string, number>) ?? {},
    activityByRole: (row.activity_by_role as Record<string, number>) ?? {},
    flaggedLowConfidence: (row.flagged_low_confidence as Array<Record<string, unknown>>) ?? [],
    recentQuestions: (row.recent_questions as Array<Record<string, unknown>>) ?? [],
  };
}

function mapAlertRow(row: Record<string, unknown>) {
  const severity = String(row.severity ?? "info");
  const uiSeverity = severity === "high" ? "warning" : severity;
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    pilotId: String(row.pilot_id),
    alertType: String(row.alert_type),
    severity: uiSeverity,
    title: String(row.title),
    description: String(row.description ?? ""),
    source: String(row.alert_type),
    triggerEvent: row.trigger_event ? String(row.trigger_event) : null,
    triggerDetails: row.trigger_details ?? {},
    relevantEvidence: row.relevant_evidence ?? [],
    recommendedAction: row.recommended_action ? String(row.recommended_action) : null,
    responsibleOwner: row.responsible_owner ? String(row.responsible_owner) : null,
    status: String(row.status),
    statusHistory: row.status_history ?? [],
    acknowledgedBy: row.acknowledged_by ? String(row.acknowledged_by) : undefined,
    acknowledgedAt: row.acknowledged_at ? String(row.acknowledged_at) : undefined,
    resolvedBy: row.resolved_by ? String(row.resolved_by) : undefined,
    resolvedAt: row.resolved_at ? String(row.resolved_at) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapEvidenceRow(row: Record<string, unknown>) {
  const dbStatus = String(row.validation_status ?? "unvalidated");
  const uiStatus = dbStatus === "unvalidated" ? "pending" : dbStatus === "rejected" ? "invalid" : dbStatus;
  const dbType = String(row.evidence_type ?? "metric");
  const uiType = dbType === "metric" ? "observation" : dbType === "quote" ? "user_feedback" : dbType;

  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    pilotId: String(row.pilot_id),
    actorUserId: String(row.actor_user_id),
    sessionId: row.session_id ? String(row.session_id) : undefined,
    evidenceType: dbType,
    type: uiType,
    title: String(row.title),
    summary: String(row.title),
    description: row.description ? String(row.description) : null,
    personIdentifier: row.person_identifier ? String(row.person_identifier) : null,
    role: row.role ? String(row.role) : null,
    trade: row.trade ? String(row.trade) : null,
    exactQuote: row.exact_quote ? String(row.exact_quote) : null,
    metricSupported: row.metric_supported ? String(row.metric_supported) : null,
    consentStatus: String(row.consent_status ?? "not_applicable"),
    supportingFileUrl: row.supporting_file_url ? String(row.supporting_file_url) : null,
    supportingUrl: row.supporting_url ? String(row.supporting_url) : null,
    validationStatus: uiStatus,
    confidence: 0.85,
    sourceQuestionId: "",
    sourceAnswerId: "",
    validatedBy: row.validated_by ? String(row.validated_by) : undefined,
    validatedAt: row.validated_at ? String(row.validated_at) : undefined,
    followUpOwner: row.follow_up_owner ? String(row.follow_up_owner) : null,
    eventId: row.event_id ? String(row.event_id) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapKnowledgeRow(row: Record<string, unknown>) {
  const dbStatus = String(row.validation_status ?? "pending");
  const uiStatus = dbStatus === "accepted" ? "approved" : dbStatus === "incorporated" ? "merged" : dbStatus;

  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    pilotId: String(row.pilot_id),
    actorUserId: String(row.actor_user_id),
    sessionId: row.session_id ? String(row.session_id) : undefined,
    contributorName: row.contributor_name ? String(row.contributor_name) : null,
    contributorIdentifier: row.contributor_identifier ? String(row.contributor_identifier) : null,
    contributor: String(row.contributor_name || row.contributor_identifier || row.actor_user_id || "Contributor"),
    tradeBranch: row.trade_branch ? String(row.trade_branch) : null,
    topic: row.topic ? String(row.topic) : null,
    category: String(row.topic || row.trade_branch || "General"),
    title: String(row.title),
    body: String(row.body),
    supportingSource: row.supporting_source ? String(row.supporting_source) : null,
    status: uiStatus,
    validationStatus: dbStatus,
    reviewedBy: row.reviewed_by ? String(row.reviewed_by) : undefined,
    reviewedAt: row.reviewed_at ? String(row.reviewed_at) : undefined,
    dateIncorporated: row.date_incorporated ? String(row.date_incorporated) : undefined,
    sourceType: String(row.source_type ?? "manual"),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toSnakeCase(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const snake = key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
    result[snake] = value;
  }
  return result;
}

export default router;
