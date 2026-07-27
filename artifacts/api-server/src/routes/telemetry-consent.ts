import { randomUUID } from "node:crypto";
import { Router } from "express";
import { resolveIdentity } from "../lib/admin-auth.js";
import { isPresentationIdentity } from "../lib/identity.js";
import {
  activityDb as db,
  CONSENT_VERSION,
  currentConsentGranted,
  latestConsent,
  PRIVACY_NOTICE_VERSION,
  resolveActiveTesterScope,
  WITHDRAWAL_DELETION_DAYS,
} from "../lib/activity-telemetry.js";

const router = Router();
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONSENT_KEYS = new Set([
  "pilotId",
  "telemetry",
  "screen",
  "microphone",
  "privacyNoticeVersion",
  "consentVersion",
]);

function isoAfterDays(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function exactKeys(value: unknown, allowed: ReadonlySet<string>): value is Record<string, unknown> {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).every((key) => allowed.has(key)),
  );
}

async function currentContext(userId: string, requestedPilotId?: string | null) {
  const membership = await resolveActiveTesterScope(userId, requestedPilotId);
  if (!membership.scope) {
    return {
      enrolled: false,
      requiresPilotSelection: membership.reason === "ambiguous_pilot",
      scope: null,
      consents: { telemetry: null, screen: null, microphone: null },
      session: null,
      privacyNoticeVersion: PRIVACY_NOTICE_VERSION,
      consentVersion: CONSENT_VERSION,
    };
  }
  const [telemetry, screen, microphone] = await Promise.all([
    latestConsent(userId, membership.scope.pilotId, "telemetry"),
    latestConsent(userId, membership.scope.pilotId, "screen"),
    latestConsent(userId, membership.scope.pilotId, "microphone"),
  ]);
  const session = await db
    .from("test_sessions")
    .select("*")
    .eq("actor_user_id", userId)
    .eq("pilot_id", membership.scope.pilotId)
    .eq("status", "active")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (session.error) throw session.error;
  return {
    enrolled: true,
    requiresPilotSelection: false,
    scope: membership.scope,
    consents: { telemetry, screen, microphone },
    session: session.data && currentConsentGranted(telemetry)
      ? {
          id: session.data.id,
          organizationId: session.data.organization_id,
          pilotId: session.data.pilot_id,
          appSessionId: session.data.app_session_id,
          status: session.data.status,
          telemetryStatus: session.data.telemetry_status,
          screenConsentState: session.data.screen_consent_state,
          microphoneConsentState: session.data.microphone_consent_state,
          onboardingStatus: session.data.onboarding_status,
          onboardingStep: session.data.onboarding_step,
          recordingStatus: session.data.recording_status,
          feedbackStatus: session.data.feedback_status,
          questionCount: session.data.question_count,
          startedAt: session.data.started_at,
          resumedAt: session.data.resumed_at,
          lastActivityAt: session.data.last_activity_at,
          expiresAt: session.data.expires_at,
        }
      : null,
    privacyNoticeVersion: PRIVACY_NOTICE_VERSION,
    consentVersion: CONSENT_VERSION,
  };
}

async function withdrawalScope(userId: string, pilotId: string | null) {
  const activeMembership = await resolveActiveTesterScope(userId, pilotId);
  if (activeMembership.scope) return activeMembership.scope;
  if (!pilotId) return null;
  const historicalConsent = await db
    .from("telemetry_consents")
    .select("*")
    .eq("actor_user_id", userId)
    .eq("pilot_id", pilotId)
    .order("occurred_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (historicalConsent.error) throw historicalConsent.error;
  if (!historicalConsent.data) return null;
  return {
    organizationId: String(historicalConsent.data.organization_id),
    pilotId: String(historicalConsent.data.pilot_id),
  };
}

router.get("/testing/telemetry/context", async (req, res) => {
  try {
    const identity = await resolveIdentity(req);
    if (!identity) return res.status(401).json({ error: "Unauthorized" });
    if (isPresentationIdentity(identity)) {
      return res.status(403).json({ error: "Pilot telemetry is unavailable for this account." });
    }
    if (identity.isAdmin) {
      return res.json({
        enrolled: false,
        requiresPilotSelection: false,
        scope: null,
        consents: { telemetry: null, screen: null, microphone: null },
        session: null,
        privacyNoticeVersion: PRIVACY_NOTICE_VERSION,
        consentVersion: CONSENT_VERSION,
      });
    }
    const pilotId =
      typeof req.query["pilotId"] === "string" && UUID_RE.test(req.query["pilotId"])
        ? req.query["pilotId"]
        : null;
    return res.json(await currentContext(identity.userId, pilotId));
  } catch (error) {
    req.log.error({ err: error }, "Could not load telemetry consent context");
    return res.status(503).json({ error: "Telemetry preferences are temporarily unavailable." });
  }
});

router.post("/testing/telemetry/consents", async (req, res) => {
  try {
    const identity = await resolveIdentity(req);
    if (!identity) return res.status(401).json({ error: "Unauthorized" });
    if (identity.isAdmin || isPresentationIdentity(identity)) {
      return res.status(403).json({ error: "Pilot telemetry is unavailable for this account." });
    }
    if (!exactKeys(req.body, CONSENT_KEYS)) {
      return res.status(400).json({ error: "Invalid consent request." });
    }
    const pilotId =
      typeof req.body.pilotId === "string" && UUID_RE.test(req.body.pilotId)
        ? req.body.pilotId
        : null;
    const telemetry = req.body.telemetry;
    const screen = req.body.screen;
    const microphone = req.body.microphone;
    if (
      !["granted", "declined"].includes(String(telemetry)) ||
      !["granted", "declined"].includes(String(screen)) ||
      !["granted", "declined"].includes(String(microphone)) ||
      req.body.privacyNoticeVersion !== PRIVACY_NOTICE_VERSION ||
      req.body.consentVersion !== CONSENT_VERSION ||
      (telemetry === "declined" && (screen !== "declined" || microphone !== "declined")) ||
      (microphone === "granted" && screen !== "granted")
    ) {
      return res.status(400).json({ error: "Invalid or outdated consent choices." });
    }
    const membership = await resolveActiveTesterScope(identity.userId, pilotId);
    if (!membership.scope) {
      return res.status(membership.reason === "ambiguous_pilot" ? 409 : 403).json({
        error:
          membership.reason === "ambiguous_pilot"
            ? "Choose one active pilot before saving consent."
            : "No active pilot membership was found.",
      });
    }
    const now = new Date().toISOString();
    const retainedUntil = new Date(
      new Date(now).setUTCMonth(new Date(now).getUTCMonth() + 24),
    ).toISOString();
    const rows = [
      { scope: "telemetry", state: telemetry },
      { scope: "screen", state: screen },
      { scope: "microphone", state: microphone },
    ].map((choice) => ({
      id: randomUUID(),
      actor_user_id: identity.userId,
      organization_id: membership.scope!.organizationId,
      pilot_id: membership.scope!.pilotId,
      scope: choice.scope,
      state: choice.state,
      privacy_notice_version: PRIVACY_NOTICE_VERSION,
      consent_version: CONSENT_VERSION,
      source: "pilot_consent_dialog",
      occurred_at: now,
      retained_until: retainedUntil,
      created_at: now,
    }));
    const inserted = await db.from("telemetry_consents").insert(rows);
    if (inserted.error) throw inserted.error;
    return res.status(201).json(await currentContext(identity.userId, membership.scope.pilotId));
  } catch (error) {
    req.log.error({ err: error }, "Could not save telemetry consent");
    return res.status(503).json({ error: "Consent choices could not be saved. Nothing was started." });
  }
});

router.post("/testing/telemetry/withdraw", async (req, res) => {
  try {
    const identity = await resolveIdentity(req);
    if (!identity) return res.status(401).json({ error: "Unauthorized" });
    if (identity.isAdmin || isPresentationIdentity(identity)) {
      return res.status(403).json({ error: "Pilot telemetry is unavailable for this account." });
    }
    if (
      !req.body ||
      typeof req.body !== "object" ||
      Array.isArray(req.body) ||
      Object.keys(req.body).some((key) => !["pilotId", "scopes"].includes(key))
    ) {
      return res.status(400).json({ error: "Invalid withdrawal request." });
    }
    const pilotId =
      typeof req.body.pilotId === "string" && UUID_RE.test(req.body.pilotId)
        ? req.body.pilotId
        : null;
    const requestedScopes = Array.isArray(req.body.scopes) ? req.body.scopes : ["telemetry"];
    if (
      requestedScopes.length === 0 ||
      requestedScopes.some(
        (scope: unknown) => !["telemetry", "screen", "microphone"].includes(String(scope)),
      )
    ) {
      return res.status(400).json({ error: "Invalid withdrawal scopes." });
    }
    const scopes = new Set<string>(requestedScopes.map(String));
    if (scopes.has("telemetry")) {
      scopes.add("screen");
      scopes.add("microphone");
    }
    const scope = await withdrawalScope(identity.userId, pilotId);
    if (!scope) return res.status(404).json({ error: "Pilot consent history not found." });
    const now = new Date().toISOString();
    const retainedUntil = new Date(
      new Date(now).setUTCMonth(new Date(now).getUTCMonth() + 24),
    ).toISOString();
    const rows = [...scopes].map((consentScope) => ({
      id: randomUUID(),
      actor_user_id: identity.userId,
      organization_id: scope.organizationId,
      pilot_id: scope.pilotId,
      scope: consentScope,
      state: "withdrawn",
      privacy_notice_version: PRIVACY_NOTICE_VERSION,
      consent_version: CONSENT_VERSION,
      source: "account_privacy",
      occurred_at: now,
      retained_until: retainedUntil,
      created_at: now,
    }));
    const inserted = await db.from("telemetry_consents").insert(rows);
    if (inserted.error) throw inserted.error;
    // The approved retention window is 24 months after withdrawal (or pilot
    // end), so extend the complete consent audit chain rather than retaining
    // only the newly appended withdrawal rows.
    const consentHistory = await db
      .from("telemetry_consents")
      .update({ retained_until: retainedUntil })
      .eq("actor_user_id", identity.userId)
      .eq("pilot_id", scope.pilotId)
      .lt("retained_until", retainedUntil);
    if (consentHistory.error) throw consentHistory.error;

    const deletionDueAt = isoAfterDays(WITHDRAWAL_DELETION_DAYS);
    if (scopes.has("telemetry")) {
      const sessions = await db
        .from("test_sessions")
        .select("id")
        .eq("actor_user_id", identity.userId)
        .eq("pilot_id", scope.pilotId);
      if (sessions.error) throw sessions.error;
      const sessionIds = (sessions.data ?? []).map((row: Record<string, unknown>) => row["id"]);
      const sessionUpdate = await db
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
        .eq("actor_user_id", identity.userId)
        .eq("pilot_id", scope.pilotId);
      if (sessionUpdate.error) throw sessionUpdate.error;
      const eventUpdate = await db
        .from("test_events")
        .update({
          metadata: {},
          correlation_id: null,
          request_id: null,
          redacted_at: now,
          deletion_due_at: deletionDueAt,
        })
        .eq("actor_user_id", identity.userId)
        .eq("pilot_id", scope.pilotId);
      if (eventUpdate.error) throw eventUpdate.error;
      const failureDelete = await db
        .from("activity_ingest_failures")
        .delete()
        .eq("actor_user_id", identity.userId)
        .eq("pilot_id", scope.pilotId);
      if (failureDelete.error) throw failureDelete.error;
      for (const sessionId of sessionIds) {
        const recordings = await db
          .from("test_recordings")
          .update({ deletion_due_at: deletionDueAt })
          .eq("tester_user_id", identity.userId)
          .eq("test_session_id", sessionId);
        if (recordings.error) throw recordings.error;
      }
    } else {
      const updates: Record<string, unknown> = { updated_at: now };
      if (scopes.has("screen")) {
        updates.screen_consent_state = "withdrawn";
        updates.recording_status = "withdrawn";
      }
      if (scopes.has("microphone")) {
        updates.microphone_consent_state = "withdrawn";
        updates.recording_status = "withdrawn";
      }
      const sessionUpdate = await db
        .from("test_sessions")
        .update(updates)
        .eq("actor_user_id", identity.userId)
        .eq("pilot_id", scope.pilotId)
        .eq("status", "active");
      if (sessionUpdate.error) throw sessionUpdate.error;
      if (scopes.has("screen") || scopes.has("microphone")) {
        let recordingQuery = db
          .from("test_recordings")
          .update({ deletion_due_at: deletionDueAt })
          .eq("tester_user_id", identity.userId)
          .eq("pilot_id", scope.pilotId);
        if (!scopes.has("screen")) {
          recordingQuery = recordingQuery.not("microphone_consent_id", "is", null);
        }
        const recordings = await recordingQuery;
        if (recordings.error) throw recordings.error;
      }
    }
    return res.json({
      withdrawn: [...scopes],
      deletionDueAt:
        scopes.has("telemetry") || scopes.has("screen") ? deletionDueAt : null,
    });
  } catch (error) {
    req.log.error({ err: error }, "Could not withdraw telemetry consent");
    return res.status(503).json({ error: "Telemetry withdrawal could not be completed." });
  }
});

router.get("/testing/telemetry/export", async (req, res) => {
  try {
    const identity = await resolveIdentity(req);
    if (!identity) return res.status(401).json({ error: "Unauthorized" });
    if (isPresentationIdentity(identity)) {
      return res.status(403).json({ error: "Pilot telemetry is unavailable for this account." });
    }
    const [consents, sessions, events, failures, recordings, feedback] = await Promise.all([
      db.from("telemetry_consents").select("*").eq("actor_user_id", identity.userId),
      db.from("test_sessions").select("*").eq("actor_user_id", identity.userId),
      db.from("test_events").select("*").eq("actor_user_id", identity.userId),
      db.from("activity_ingest_failures").select("*").eq("actor_user_id", identity.userId),
      db
        .from("test_recordings")
        .select("id,session_id,test_session_id,mime_type,duration_ms,size_bytes,created_at,retained_until,deletion_due_at")
        .eq("tester_user_id", identity.userId),
      db
        .from("test_feedback")
        .select("id,session_id,test_session_id,features_used,device_category,trigger,goal,useful,shortfall,adoption_need,additional,status,created_at,updated_at,retained_until,deletion_due_at")
        .eq("tester_user_id", identity.userId),
    ]);
    const failed = [consents, sessions, events, failures, recordings, feedback].find(
      (result) => result.error,
    );
    if (failed?.error) throw failed.error;
    res.setHeader("Content-Disposition", 'attachment; filename="jack-telemetry-export.json"');
    res.setHeader("Cache-Control", "no-store");
    return res.json({
      exportedAt: new Date().toISOString(),
      notice:
        "Ask Jack conversation history is product data and is not duplicated in this optional telemetry export.",
      consents: consents.data ?? [],
      sessions: sessions.data ?? [],
      events: events.data ?? [],
      ingestionFailures: failures.data ?? [],
      recordings: recordings.data ?? [],
      feedback: feedback.data ?? [],
    });
  } catch (error) {
    req.log.error({ err: error }, "Could not export telemetry");
    return res.status(503).json({ error: "Telemetry export could not be generated." });
  }
});

export default router;
