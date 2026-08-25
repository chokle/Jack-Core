import { randomUUID } from "node:crypto";
import { Router } from "express";
import { resolveIdentity } from "../lib/admin-auth.js";
import { denyRestrictedIdentity } from "../lib/identity.js";
import {
  activityDb as db,
  browserFamily,
  currentConsentGranted,
  latestConsent,
  RAW_EVENT_RETENTION_DAYS,
  TELEMETRY_SCHEMA_VERSION,
} from "../lib/activity-telemetry.js";

const router = Router();
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEVICE_CATEGORIES = new Set(["desktop", "tablet", "mobile"]);

function retainedUntil(): string {
  return new Date(Date.now() + RAW_EVENT_RETENTION_DAYS * 86_400_000).toISOString();
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
      return res.status(403).json({ error: "Pilot telemetry is unavailable for this account." });
    }

    const body = req.body ?? {};
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some(
        (key) => !["appSessionId", "visibility", "meaningfulActivity", "deviceCategory"].includes(key),
      )
    ) {
      return res.status(400).json({ error: "Invalid activity heartbeat." });
    }

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
      .eq("actor_user_id", identity.userId)
      .eq("app_session_id", appSessionId)
      .eq("status", "active")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (session.error) throw session.error;
    if (!session.data) {
      return res.status(409).json({ error: "No active pilot session was found." });
    }

    const consent = await latestConsent(
      identity.userId,
      String(session.data.pilot_id),
      "telemetry",
    );
    if (!currentConsentGranted(consent)) {
      return res.status(412).json({ error: "Telemetry consent is not currently granted." });
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

    const updated = await db
      .from("test_sessions")
      .update({ last_activity_at: now, updated_at: now })
      .eq("id", session.data.id)
      .eq("actor_user_id", identity.userId);
    if (updated.error) throw updated.error;

    return res.status(201).json({ accepted: true, eventId });
  } catch (error) {
    req.log.error({ err: error }, "Could not record activity heartbeat");
    return res.status(503).json({ error: "Activity heartbeat could not be recorded." });
  }
});

export default router;
