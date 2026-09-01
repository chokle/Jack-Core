import { randomUUID } from "node:crypto";
import { Router } from "express";
import { resolveIdentity } from "../lib/admin-auth.js";
import { denyRestrictedIdentity } from "../lib/identity.js";
import {
  activeTesterScopeMatches,
  activityDb as db,
  browserFamily,
  compensateTelemetryWriteAfterWithdrawal,
  currentConsentGranted,
  latestConsent,
  RAW_EVENT_RETENTION_DAYS,
  TELEMETRY_SCHEMA_VERSION,
  WITHDRAWAL_DELETION_DAYS,
} from "../lib/activity-telemetry.js";

const router = Router();
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEVICE_CATEGORIES = new Set(["desktop", "tablet", "mobile"]);

function retainedUntil(): string {
  return new Date(
    Date.now() + RAW_EVENT_RETENTION_DAYS * 86_400_000,
  ).toISOString();
}

function withdrawalDeletionDueAt(): string {
  return new Date(
    Date.now() + WITHDRAWAL_DELETION_DAYS * 86_400_000,
  ).toISOString();
}

type TelemetryConsentFence = "exact" | "granted-refresh" | "revoked";

async function telemetryConsentFenceState(
  userId: string,
  pilotId: string,
  consentId: string,
): Promise<TelemetryConsentFence> {
  const current = await latestConsent(userId, pilotId, "telemetry");
  if (!currentConsentGranted(current)) return "revoked";
  return current.id === consentId ? "exact" : "granted-refresh";
}

async function redactRejectedHeartbeat(input: {
  eventId: string;
  userId: string;
  pilotId: string;
  sessionId: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const redacted = await db
    .from("test_events")
    .update({
      metadata: {},
      correlation_id: null,
      request_id: null,
      redacted_at: now,
      deletion_due_at: withdrawalDeletionDueAt(),
    })
    .eq("event_id", input.eventId)
    .eq("event_type", "activity_heartbeat")
    .eq("actor_user_id", input.userId)
    .eq("pilot_id", input.pilotId)
    .eq("test_session_id", input.sessionId);
  if (redacted.error) throw redacted.error;
}

router.post("/testing/activity-heartbeat", async (req, res) => {
  try {
    const identity = await resolveIdentity(req);
    if (!identity) return res.status(401).json({ error: "Unauthorized" });
    if (
      denyRestrictedIdentity(
        res,
        identity,
        "Pilot telemetry is unavailable for this account.",
        "Pilot telemetry is temporarily unavailable.",
      )
    ) {
      return;
    }
    if (identity.isAdmin) {
      return res
        .status(403)
        .json({ error: "Pilot telemetry is unavailable for this account." });
    }

    const body = req.body ?? {};
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some(
        (key) =>
          ![
            "testSessionId",
            "appSessionId",
            "visibility",
            "meaningfulActivity",
            "deviceCategory",
          ].includes(key),
      )
    ) {
      return res.status(400).json({ error: "Invalid activity heartbeat." });
    }

    const requestedTestSessionId =
      typeof body.testSessionId === "string" && UUID_RE.test(body.testSessionId)
        ? body.testSessionId
        : null;
    const appSessionId =
      typeof body.appSessionId === "string" && UUID_RE.test(body.appSessionId)
        ? body.appSessionId
        : null;
    const visibility =
      body.visibility === "foreground" || body.visibility === "hidden"
        ? body.visibility
        : null;
    const meaningfulActivity = body.meaningfulActivity;
    const deviceCategory = DEVICE_CATEGORIES.has(body.deviceCategory)
      ? body.deviceCategory
      : "desktop";

    if (
      !requestedTestSessionId ||
      !appSessionId ||
      !visibility ||
      typeof meaningfulActivity !== "boolean" ||
      (visibility === "hidden" && meaningfulActivity)
    ) {
      return res.status(400).json({ error: "Invalid activity heartbeat." });
    }

    const session = await db
      .from("test_sessions")
      .select("*")
      .eq("id", requestedTestSessionId)
      .eq("actor_user_id", identity.userId)
      .eq("app_session_id", appSessionId)
      .eq("status", "active")
      .eq("telemetry_status", "granted")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (session.error) throw session.error;
    if (!session.data) {
      return res
        .status(409)
        .json({ error: "No active pilot session was found." });
    }

    const pilotId = String(session.data.pilot_id);
    const organizationId = String(session.data.organization_id);
    const testSessionId = String(session.data.id);
    if (
      !(await activeTesterScopeMatches(
        identity.userId,
        organizationId,
        pilotId,
      ))
    ) {
      return res
        .status(403)
        .json({ error: "No active pilot membership was found." });
    }

    const consent = await latestConsent(identity.userId, pilotId, "telemetry");
    if (
      !currentConsentGranted(consent) ||
      consent.id !== String(session.data.telemetry_consent_id ?? "")
    ) {
      return res
        .status(412)
        .json({ error: "Telemetry consent is not currently granted." });
    }

    const now = new Date().toISOString();
    const eventId = randomUUID();
    const inserted = await db.from("test_events").insert({
      event_id: eventId,
      actor_user_id: identity.userId,
      organization_id: session.data.organization_id,
      pilot_id: session.data.pilot_id,
      test_session_id: session.data.id,
      app_session_id: appSessionId,
      event_type: "activity_heartbeat",
      occurred_at: now,
      received_at: now,
      surface: "app",
      route: "/app",
      schema_version: TELEMETRY_SCHEMA_VERSION,
      metadata: {
        visibility,
        meaningful_activity: meaningfulActivity,
      },
      consent_state: "granted",
      consent_id: consent.id,
      privacy_notice_version: consent.privacyNoticeVersion,
      consent_version: consent.consentVersion,
      app_version: null,
      deploy_version: null,
      device_category: deviceCategory,
      browser_family: browserFamily(req.headers["user-agent"]),
      result: "success",
      correlation_id: null,
      request_id: null,
      dedupe_key: null,
      retention_category: "raw_activity_90d",
      retained_until: retainedUntil(),
    });
    if (inserted.error) throw inserted.error;

    const compensateWithdrawal = () =>
      compensateTelemetryWriteAfterWithdrawal(
        identity.userId,
        pilotId,
        testSessionId,
      );
    const enforceConsentFence = async (): Promise<
      Exclude<TelemetryConsentFence, "exact"> | null
    > => {
      const state = await telemetryConsentFenceState(
        identity.userId,
        pilotId,
        consent.id,
      );
      if (state === "exact") return null;
      if (state === "revoked") {
        await compensateWithdrawal();
      } else {
        await redactRejectedHeartbeat({
          eventId,
          userId: identity.userId,
          pilotId,
          sessionId: testSessionId,
        });
      }
      return state;
    };
    const consentFenceResponse = (
      state: Exclude<TelemetryConsentFence, "exact">,
    ) =>
      res.status(state === "revoked" ? 412 : 409).json({
        error:
          state === "revoked"
            ? "Telemetry consent is not currently granted."
            : "Telemetry consent changed while the activity heartbeat was being recorded.",
      });

    const postInsertConsentFence = await enforceConsentFence();
    if (postInsertConsentFence) {
      return consentFenceResponse(postInsertConsentFence);
    }

    const sessionFence =
      visibility === "foreground" && meaningfulActivity
        ? await db
            .from("test_sessions")
            .update({ last_activity_at: now, updated_at: now })
            .eq("id", testSessionId)
            .eq("actor_user_id", identity.userId)
            .eq("organization_id", organizationId)
            .eq("pilot_id", pilotId)
            .eq("app_session_id", appSessionId)
            .eq("status", "active")
            .eq("telemetry_status", "granted")
            .eq("telemetry_consent_id", consent.id)
            .select("id")
            .maybeSingle()
        : await db
            .from("test_sessions")
            .select("id")
            .eq("id", testSessionId)
            .eq("actor_user_id", identity.userId)
            .eq("organization_id", organizationId)
            .eq("pilot_id", pilotId)
            .eq("app_session_id", appSessionId)
            .eq("status", "active")
            .eq("telemetry_status", "granted")
            .eq("telemetry_consent_id", consent.id)
            .maybeSingle();
    if (sessionFence.error) {
      const failedProjectionConsentFence = await enforceConsentFence();
      if (failedProjectionConsentFence) {
        return consentFenceResponse(failedProjectionConsentFence);
      }
      throw sessionFence.error;
    }

    if (!sessionFence.data) {
      const missingSessionConsentFence = await enforceConsentFence();
      if (missingSessionConsentFence) {
        return consentFenceResponse(missingSessionConsentFence);
      }
      await redactRejectedHeartbeat({
        eventId,
        userId: identity.userId,
        pilotId,
        sessionId: testSessionId,
      });
      return res
        .status(409)
        .json({ error: "No active pilot session was found." });
    }

    const finalConsentFence = await enforceConsentFence();
    if (finalConsentFence) {
      return consentFenceResponse(finalConsentFence);
    }

    return res.status(201).json({ accepted: true, eventId });
  } catch (error) {
    req.log.error({ err: error }, "Could not record activity heartbeat");
    return res
      .status(503)
      .json({ error: "Activity heartbeat could not be recorded." });
  }
});

export default router;
