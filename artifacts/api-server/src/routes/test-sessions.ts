import { randomUUID } from "node:crypto";
import { Router, type Request } from "express";
import { resolveIdentity } from "../lib/admin-auth.js";
import { denyRestrictedIdentity } from "../lib/identity.js";
import {
  activityDb as db,
  currentConsentGranted,
  insertCanonicalEvent,
  latestConsent,
  recordIngestFailure,
  resolveActiveTesterScope,
  validateCanonicalEventInput,
  WITHDRAWAL_DELETION_DAYS,
  type CanonicalEventInput,
} from "../lib/activity-telemetry.js";

const router = Router();
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const START_KEYS = new Set([
  "pilotId",
  "appSessionId",
  "appVersion",
  "deployVersion",
  "deviceCategory",
]);
const EVENT_KEYS = new Set([
  "eventId",
  "eventType",
  "occurredAt",
  "appSessionId",
  "metadata",
  "result",
  "correlationId",
  "requestId",
  "dedupeKey",
  "appVersion",
  "deployVersion",
  "deviceCategory",
  "schemaVersion",
]);

function hasOnlyKeys(value: unknown, allowed: ReadonlySet<string>): value is Record<string, unknown> {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).every((key) => allowed.has(key)),
  );
}

function eventProjectionFromRow(
  session: Record<string, any>,
  event: Record<string, any>,
  now: string,
  duplicate: boolean,
): Record<string, unknown> {
  const canonicalEventType = String(event["event_type"] ?? "");
  const metadata = (event["metadata"] ?? {}) as Record<string, unknown>;
  const updates: Record<string, unknown> = {
    app_session_id: event["app_session_id"] ?? session.app_session_id,
    last_activity_at: now,
    updated_at: now,
  };
  if (canonicalEventType === "onboarding_started") updates.onboarding_status = "in_progress";
  if (canonicalEventType === "onboarding_step_completed") {
    updates.onboarding_status = "in_progress";
    updates.onboarding_step = metadata["next_step"] ?? session.onboarding_step;
  }
  if (canonicalEventType === "onboarding_completed") {
    updates.onboarding_status = "completed";
    updates.onboarding_step = 3;
  }
  if (canonicalEventType === "onboarding_skipped") {
    updates.onboarding_status = "skipped";
  }
  if (canonicalEventType === "recording_started") updates.recording_status = "recording";
  if (canonicalEventType === "recording_stopped") updates.recording_status = "stopped";
  if (canonicalEventType === "recording_upload_succeeded") updates.recording_status = "uploaded";
  if (canonicalEventType === "recording_upload_failed") {
    updates.recording_status = "failed";
    updates.error_count = Number(session.error_count ?? 0) + (duplicate ? 0 : 1);
  }
  if (canonicalEventType === "feedback_submitted") updates.feedback_status = "submitted";
  if (canonicalEventType === "test_completed") {
    updates.status = "completed";
    updates.completed_at = now;
  }
  if (canonicalEventType === "test_abandoned") updates.status = "abandoned";
  if (canonicalEventType === "reliability_error") {
    updates.error_count = Number(session.error_count ?? 0) + (duplicate ? 0 : 1);
  }
  return updates;
}

function publicSession(row: Record<string, any>) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    pilotId: row.pilot_id,
    appSessionId: row.app_session_id,
    status: row.status,
    telemetryStatus: row.telemetry_status,
    screenConsentState: row.screen_consent_state,
    microphoneConsentState: row.microphone_consent_state,
    onboardingStatus: row.onboarding_status,
    onboardingStep: row.onboarding_step,
    recordingStatus: row.recording_status,
    feedbackStatus: row.feedback_status,
    questionCount: row.question_count,
    startedAt: row.started_at,
    resumedAt: row.resumed_at,
    lastActivityAt: row.last_activity_at,
    expiresAt: row.expires_at,
  };
}

async function activeSession(userId: string, pilotId: string) {
  return db
    .from("test_sessions")
    .select("*")
    .eq("actor_user_id", userId)
    .eq("pilot_id", pilotId)
    .eq("status", "active")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
}

function deletionDueAfterWithdrawal(): string {
  return new Date(
    Date.now() + WITHDRAWAL_DELETION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
}

async function telemetryConsentStillCurrent(
  userId: string,
  pilotId: string,
  expectedConsentId: string,
): Promise<boolean> {
  const current = await latestConsent(userId, pilotId, "telemetry");
  return currentConsentGranted(current) && current.id === expectedConsentId;
}

async function compensateTelemetryConsentRace(
  userId: string,
  pilotId: string,
  sessionId: string,
): Promise<void> {
  const now = new Date().toISOString();
  const deletionDueAt = deletionDueAfterWithdrawal();
  const results = await Promise.all([
    db
      .from("test_sessions")
      .update({
        status: "withdrawn",
        telemetry_status: "withdrawn",
        screen_consent_state: "withdrawn",
        microphone_consent_state: "withdrawn",
        recording_status: "withdrawn",
        deletion_due_at: deletionDueAt,
        updated_at: now,
      })
      .eq("id", sessionId)
      .eq("actor_user_id", userId)
      .eq("pilot_id", pilotId),
    db
      .from("test_events")
      .update({
        metadata: {},
        correlation_id: null,
        request_id: null,
        redacted_at: now,
        deletion_due_at: deletionDueAt,
      })
      .eq("test_session_id", sessionId)
      .eq("actor_user_id", userId)
      .eq("pilot_id", pilotId),
    db
      .from("activity_ingest_failures")
      .delete()
      .eq("test_session_id", sessionId)
      .eq("actor_user_id", userId)
      .eq("pilot_id", pilotId),
    db
      .from("test_recordings")
      .update({ deletion_due_at: deletionDueAt })
      .eq("test_session_id", sessionId)
      .eq("tester_user_id", userId)
      .eq("pilot_id", pilotId),
  ]);
  const failed = results.find((result) => result.error);
  if (failed?.error) throw failed.error;
}

async function expireSessionIfNeeded(
  row: Record<string, any>,
  userId: string,
  req: Request,
): Promise<boolean> {
  const expiresAt = Date.parse(String(row.expires_at ?? ""));
  if (!Number.isFinite(expiresAt) || expiresAt > Date.now()) return false;
  const pilotId = String(row.pilot_id);
  const consent = await latestConsent(userId, pilotId, "telemetry");
  const now = new Date().toISOString();
  const updated = await db
    .from("test_sessions")
    .update({ status: "expired", last_activity_at: now, updated_at: now })
    .eq("id", row.id)
    .eq("actor_user_id", userId);
  if (updated.error) throw updated.error;
  if (currentConsentGranted(consent)) {
    if (!(await telemetryConsentStillCurrent(userId, pilotId, consent.id))) {
      await compensateTelemetryConsentRace(userId, pilotId, String(row.id));
      return true;
    }
    const event = await insertCanonicalEvent({
      req,
      actorUserId: userId,
      session: row,
      consent,
      clientEvent: false,
      event: {
        eventId: randomUUID(),
        eventType: "test_expired",
        appSessionId: String(row.app_session_id),
        occurredAt: now,
        metadata: {},
        result: "unavailable",
        dedupeKey: "test_expired",
        deviceCategory: "desktop",
      },
    });
    if (event.error) throw new Error(event.error);
    if (!(await telemetryConsentStillCurrent(userId, pilotId, consent.id))) {
      await compensateTelemetryConsentRace(userId, pilotId, String(row.id));
    }
  }
  return true;
}

router.post("/testing/sessions/start", async (req, res) => {
  try {
    const identity = await resolveIdentity(req);
    if (!identity) return res.status(401).json({ error: "Unauthorized" });
    if (
      denyRestrictedIdentity(
        res,
        identity,
        "Pilot sessions are unavailable for this account.",
        "Pilot sessions are temporarily unavailable.",
      )
    ) return;
    if (identity.isAdmin) {
      return res.status(403).json({ error: "Pilot sessions are unavailable for this account." });
    }
    if (!hasOnlyKeys(req.body ?? {}, START_KEYS)) {
      return res.status(400).json({ error: "Invalid pilot-session request." });
    }
    const requestedPilotId =
      typeof req.body?.pilotId === "string" && UUID_RE.test(req.body.pilotId)
        ? req.body.pilotId
        : null;
    if (req.body?.pilotId != null && !requestedPilotId) {
      return res.status(400).json({ error: "Invalid pilot identifier." });
    }
    const requestedAppSessionId =
      typeof req.body?.appSessionId === "string" && UUID_RE.test(req.body.appSessionId)
        ? req.body.appSessionId
        : req.body?.appSessionId == null
          ? randomUUID()
          : null;
    if (!requestedAppSessionId) {
      return res.status(400).json({ error: "Invalid app-session identifier." });
    }
    const validatedStart = validateCanonicalEventInput(
      {
        eventType: "test_started",
        appSessionId: requestedAppSessionId,
        metadata: {},
        result: "success",
        appVersion: req.body?.appVersion,
        deployVersion: req.body?.deployVersion,
        deviceCategory: req.body?.deviceCategory,
      },
      false,
    );
    if ("error" in validatedStart) {
      return res.status(400).json({ error: "Invalid pilot-session metadata.", code: validatedStart.error });
    }
    const membership = await resolveActiveTesterScope(identity.userId, requestedPilotId);
    if (!membership.scope) {
      return res.status(membership.reason === "ambiguous_pilot" ? 409 : 403).json({
        error:
          membership.reason === "ambiguous_pilot"
            ? "Choose one active pilot before starting telemetry."
            : "No active pilot membership was found.",
      });
    }
    const telemetryConsent = await latestConsent(
      identity.userId,
      membership.scope.pilotId,
      "telemetry",
    );
    if (!currentConsentGranted(telemetryConsent)) {
      return res.status(412).json({
        error: "Explicit optional telemetry consent is required before a pilot session is created.",
      });
    }
    const screenConsent = await latestConsent(identity.userId, membership.scope.pilotId, "screen");
    const microphoneConsent = await latestConsent(
      identity.userId,
      membership.scope.pilotId,
      "microphone",
    );
    const existing = await activeSession(identity.userId, membership.scope.pilotId);
    if (existing.error) throw existing.error;
    if (existing.data && !(await expireSessionIfNeeded(existing.data, identity.userId, req))) {
      const resumedAt = new Date().toISOString();
      const updated = await db
        .from("test_sessions")
        .update({
          app_session_id: requestedAppSessionId,
          device_category: validatedStart.value.deviceCategory,
          telemetry_consent_id: telemetryConsent.id,
          screen_consent_id: currentConsentGranted(screenConsent) ? screenConsent.id : null,
          microphone_consent_id: currentConsentGranted(microphoneConsent)
            ? microphoneConsent.id
            : null,
          screen_consent_state: currentConsentGranted(screenConsent) ? "granted" : "declined",
          microphone_consent_state: currentConsentGranted(microphoneConsent)
            ? "granted"
            : "declined",
          resumed_at: resumedAt,
          last_activity_at: resumedAt,
          updated_at: resumedAt,
        })
        .eq("id", existing.data.id)
        .eq("actor_user_id", identity.userId)
        .select("*")
        .single();
      if (updated.error) throw updated.error;
      if (
        !(await telemetryConsentStillCurrent(
          identity.userId,
          membership.scope.pilotId,
          telemetryConsent.id,
        ))
      ) {
        await compensateTelemetryConsentRace(
          identity.userId,
          membership.scope.pilotId,
          String(updated.data.id),
        );
        return res.status(409).json({
          error: "Telemetry consent changed while the pilot session was starting.",
        });
      }
      await insertCanonicalEvent({
        req,
        actorUserId: identity.userId,
        session: updated.data,
        consent: telemetryConsent,
        clientEvent: false,
        event: {
          eventId: randomUUID(),
          eventType: "test_resumed",
          appSessionId: requestedAppSessionId,
          occurredAt: resumedAt,
          metadata: {},
          result: "success",
          dedupeKey: `test_resumed:${requestedAppSessionId}`,
          appVersion: validatedStart.value.appVersion ?? null,
          deployVersion: validatedStart.value.deployVersion ?? null,
          deviceCategory: validatedStart.value.deviceCategory,
        },
      });
      if (
        !(await telemetryConsentStillCurrent(
          identity.userId,
          membership.scope.pilotId,
          telemetryConsent.id,
        ))
      ) {
        await compensateTelemetryConsentRace(
          identity.userId,
          membership.scope.pilotId,
          String(updated.data.id),
        );
        return res.status(409).json({
          error: "Telemetry consent changed while the pilot session was starting.",
        });
      }
      return res.json({ session: publicSession(updated.data), resumed: true });
    }

    const now = new Date().toISOString();
    const sessionId = randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const inserted = await db
      .from("test_sessions")
      .insert({
        id: sessionId,
        actor_user_id: identity.userId,
        organization_id: membership.scope.organizationId,
        pilot_id: membership.scope.pilotId,
        app_session_id: requestedAppSessionId,
        device_category: validatedStart.value.deviceCategory,
        status: "active",
        telemetry_status: "granted",
        telemetry_consent_id: telemetryConsent.id,
        screen_consent_id: currentConsentGranted(screenConsent) ? screenConsent.id : null,
        microphone_consent_id: currentConsentGranted(microphoneConsent)
          ? microphoneConsent.id
          : null,
        screen_consent_state: currentConsentGranted(screenConsent) ? "granted" : "declined",
        microphone_consent_state: currentConsentGranted(microphoneConsent)
          ? "granted"
          : "declined",
        onboarding_status: "not_started",
        onboarding_step: 0,
        recording_status: "not_requested",
        feedback_status: "not_requested",
        question_count: 0,
        error_count: 0,
        started_at: now,
        last_activity_at: now,
        expires_at: expiresAt,
        created_at: now,
        updated_at: now,
      })
      .select("*")
      .single();
    if (inserted.error) {
      if ((inserted.error as { code?: string }).code === "23505") {
        const raced = await activeSession(identity.userId, membership.scope.pilotId);
        if (raced.error) throw raced.error;
        if (raced.data) {
          if (
            !(await telemetryConsentStillCurrent(
              identity.userId,
              membership.scope.pilotId,
              telemetryConsent.id,
            ))
          ) {
            await compensateTelemetryConsentRace(
              identity.userId,
              membership.scope.pilotId,
              String(raced.data.id),
            );
            return res.status(409).json({
              error: "Telemetry consent changed while the pilot session was starting.",
            });
          }
          return res.json({ session: publicSession(raced.data), resumed: true });
        }
      }
      throw inserted.error;
    }
    if (
      !(await telemetryConsentStillCurrent(
        identity.userId,
        membership.scope.pilotId,
        telemetryConsent.id,
      ))
    ) {
      await compensateTelemetryConsentRace(
        identity.userId,
        membership.scope.pilotId,
        String(inserted.data.id),
      );
      return res.status(409).json({
        error: "Telemetry consent changed while the pilot session was starting.",
      });
    }
    const event = await insertCanonicalEvent({
      req,
      actorUserId: identity.userId,
      session: inserted.data,
      consent: telemetryConsent,
      clientEvent: false,
      event: {
        eventId: randomUUID(),
        eventType: "test_started",
        appSessionId: requestedAppSessionId,
        occurredAt: now,
        metadata: {},
        result: "success",
        dedupeKey: "test_started",
        appVersion: validatedStart.value.appVersion ?? null,
        deployVersion: validatedStart.value.deployVersion ?? null,
        deviceCategory: validatedStart.value.deviceCategory,
      },
    });
    if (event.error) throw new Error(event.error);
    if (
      !(await telemetryConsentStillCurrent(
        identity.userId,
        membership.scope.pilotId,
        telemetryConsent.id,
      ))
    ) {
      await compensateTelemetryConsentRace(
        identity.userId,
        membership.scope.pilotId,
        String(inserted.data.id),
      );
      return res.status(409).json({
        error: "Telemetry consent changed while the pilot session was starting.",
      });
    }
    return res.status(201).json({ session: publicSession(inserted.data), resumed: false });
  } catch (error) {
    req.log.error({ err: error }, "Could not start pilot session");
    return res.status(503).json({ error: "Pilot session could not be started. Please try again." });
  }
});

router.get("/testing/sessions/current", async (req, res) => {
  try {
    const identity = await resolveIdentity(req);
    if (!identity) return res.status(401).json({ error: "Unauthorized" });
    if (
      denyRestrictedIdentity(
        res,
        identity,
        "Forbidden",
        "Pilot sessions are temporarily unavailable.",
      )
    ) return;
    if (identity.isAdmin) {
      return res.json({ session: null });
    }
    const requestedPilotId =
      typeof req.query["pilotId"] === "string" && UUID_RE.test(req.query["pilotId"])
        ? req.query["pilotId"]
        : null;
    const membership = await resolveActiveTesterScope(identity.userId, requestedPilotId);
    if (!membership.scope) return res.json({ session: null });
    const result = await activeSession(identity.userId, membership.scope.pilotId);
    if (result.error) throw result.error;
    if (result.data && (await expireSessionIfNeeded(result.data, identity.userId, req))) {
      return res.json({ session: null });
    }
    return res.json({ session: result.data ? publicSession(result.data) : null });
  } catch (error) {
    req.log.error({ err: error }, "Could not load current pilot session");
    return res.status(503).json({ error: "Pilot session could not be loaded" });
  }
});

router.post("/testing/sessions/:id/events", async (req, res) => {
  const identity = await resolveIdentity(req);
  if (!identity) return res.status(401).json({ error: "Unauthorized" });
  if (
    denyRestrictedIdentity(
      res,
      identity,
      "Forbidden",
      "Pilot session updates are temporarily unavailable.",
    )
  ) return;
  if (identity.isAdmin) {
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    if (!hasOnlyKeys(req.body ?? {}, EVENT_KEYS) || req.body?.schemaVersion !== 1) {
      await recordIngestFailure({
        actorUserId: identity.userId,
        testSessionId: req.params.id,
        reasonCode: "invalid_envelope",
        outcome: "rejected",
      });
      return res.status(400).json({ error: "Invalid activity-event envelope." });
    }
    const event: CanonicalEventInput = {
      eventId: req.body.eventId,
      eventType: req.body.eventType,
      occurredAt: req.body.occurredAt,
      appSessionId: req.body.appSessionId,
      metadata: req.body.metadata,
      result: req.body.result,
      correlationId: req.body.correlationId,
      requestId: req.body.requestId,
      dedupeKey: req.body.dedupeKey,
      appVersion: req.body.appVersion,
      deployVersion: req.body.deployVersion,
      deviceCategory: req.body.deviceCategory,
    };
    const prevalidated = validateCanonicalEventInput(event, true);
    if (!("error" in prevalidated)) {
      const existingEvent = await db
        .from("test_events")
        .select("event_id")
        .eq("event_id", prevalidated.value.eventId)
        .eq("test_session_id", req.params.id)
        .eq("actor_user_id", identity.userId)
        .maybeSingle();
      if (existingEvent.error) throw existingEvent.error;
      if (existingEvent.data) {
        const existingSession = await db
          .from("test_sessions")
          .select("*")
          .eq("id", req.params.id)
          .eq("actor_user_id", identity.userId)
          .maybeSingle();
        if (existingSession.error) throw existingSession.error;
        if (!existingSession.data) return res.status(404).json({ error: "Pilot session not found" });
        const duplicateProjection = eventProjectionFromRow(
          existingSession.data,
          existingEvent.data,
          new Date().toISOString(),
          true,
        );
        const projected = await db
          .from("test_sessions")
          .update(duplicateProjection)
          .eq("id", req.params.id)
          .eq("actor_user_id", identity.userId)
          .select("*")
          .single();
        if (projected.error) throw projected.error;
        return res.json({
          accepted: true,
          duplicate: true,
          session: publicSession(projected.data),
        });
      }
    }
    const session = await db
      .from("test_sessions")
      .select("*")
      .eq("id", req.params.id)
      .eq("actor_user_id", identity.userId)
      .eq("status", "active")
      .eq("telemetry_status", "granted")
      .maybeSingle();
    if (session.error) throw session.error;
    if (!session.data) {
      await recordIngestFailure({
        actorUserId: identity.userId,
        testSessionId: req.params.id,
        reasonCode: "session_not_active",
        outcome: "rejected",
      });
      return res.status(404).json({ error: "Active pilot session not found" });
    }
    const consent = await latestConsent(identity.userId, String(session.data.pilot_id), "telemetry");
    if (!currentConsentGranted(consent)) {
      await recordIngestFailure({
        actorUserId: identity.userId,
        organizationId: session.data.organization_id,
        pilotId: session.data.pilot_id,
        testSessionId: session.data.id,
        reasonCode: "consent_not_granted",
        outcome: "rejected",
      });
      return res.status(409).json({ error: "Telemetry consent is not active." });
    }
    const inserted = await insertCanonicalEvent({
      req,
      actorUserId: identity.userId,
      session: session.data,
      consent,
      event,
      clientEvent: true,
    });
    if (inserted.error) {
      await recordIngestFailure({
        actorUserId: identity.userId,
        organizationId: session.data.organization_id,
        pilotId: session.data.pilot_id,
        testSessionId: session.data.id,
        reasonCode: inserted.error,
        outcome: "rejected",
      });
      return res.status(400).json({ error: "Activity event was rejected.", code: inserted.error });
    }

    const now = new Date().toISOString();
    const updates = eventProjectionFromRow(
      session.data,
      {
        event_type: inserted.row?.["event_type"] ?? event.eventType,
        metadata: (inserted.row?.["metadata"] ?? event.metadata) as Record<string, unknown>,
        app_session_id: inserted.row?.["app_session_id"] ?? event.appSessionId,
      },
      now,
      inserted.duplicate,
    );
    const updated = await db
      .from("test_sessions")
      .update(updates)
      .eq("id", req.params.id)
      .eq("actor_user_id", identity.userId)
      .select("*")
      .single();
    if (updated.error) throw updated.error;
    return res.status(inserted.duplicate ? 200 : 201).json({
      accepted: true,
      duplicate: inserted.duplicate,
      session: publicSession(updated.data),
    });
  } catch (error) {
    req.log.error({ err: error }, "Could not record activity event");
    return res.status(503).json({ error: "Test progress could not be saved" });
  }
});

router.post("/testing/sessions/:id/ingest-failures", async (req, res) => {
  const identity = await resolveIdentity(req);
  if (!identity) return res.status(401).json({ error: "Unauthorized" });
  if (
    denyRestrictedIdentity(
      res,
      identity,
      "Forbidden",
      "Pilot session updates are temporarily unavailable.",
    )
  ) return;
  if (identity.isAdmin) {
    return res.status(403).json({ error: "Forbidden" });
  }
  if (
    !req.body ||
    typeof req.body !== "object" ||
    Array.isArray(req.body) ||
    Object.keys(req.body).some((key) => !["reasonCode", "eventCount"].includes(key)) ||
    req.body.reasonCode !== "queue_overflow" ||
    !Number.isInteger(req.body.eventCount) ||
    req.body.eventCount < 1 ||
    req.body.eventCount > 1000
  ) {
    return res.status(400).json({ error: "Invalid dropped-event counter." });
  }
  const session = await db
    .from("test_sessions")
    .select("id,organization_id,pilot_id")
    .eq("id", req.params.id)
    .eq("actor_user_id", identity.userId)
    .eq("status", "active")
    .eq("telemetry_status", "granted")
    .maybeSingle();
  if (session.error) throw session.error;
  if (!session.data) return res.status(404).json({ error: "Pilot session not found." });
  const consent = await latestConsent(identity.userId, String(session.data.pilot_id), "telemetry");
  if (!currentConsentGranted(consent)) {
    return res.status(409).json({ error: "Telemetry consent is not active." });
  }
  await recordIngestFailure({
    actorUserId: identity.userId,
    organizationId: session.data.organization_id,
    pilotId: session.data.pilot_id,
    testSessionId: session.data.id,
    reasonCode: "queue_overflow",
    outcome: "dropped",
    eventCount: req.body.eventCount,
  });
  return res.status(202).json({ accepted: true });
});

export default router;
