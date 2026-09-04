import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { resolveIdentity, type CallerIdentity } from "./admin-auth.js";
import { isPresentationIdentity, isUnavailableIdentity } from "./identity.js";
import {
  activityDb as db,
  compensateTelemetryWriteAfterWithdrawal,
  currentConsentGranted,
  deviceCategory,
  latestConsent,
  resolveActiveTesterScope,
} from "./activity-telemetry.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function hasValidSessionHint(req: Request): boolean {
  const value = req.headers["x-jack-test-session-id"];
  return typeof value === "string" && UUID_RE.test(value);
}

function sessionUsesExactTelemetryConsent(
  row: Record<string, any>,
  consentId: string,
): boolean {
  return (
    row.status === "active" &&
    row.telemetry_status === "granted" &&
    String(row.telemetry_consent_id) === consentId
  );
}

async function activeScopedSessions(userId: string, pilotId: string) {
  return db
    .from("test_sessions")
    .select("*")
    .eq("actor_user_id", userId)
    .eq("pilot_id", pilotId)
    .eq("status", "active")
    .order("last_activity_at", { ascending: false })
    .limit(2);
}

async function telemetryConsentStillCurrent(
  userId: string,
  pilotId: string,
  consentId: string,
): Promise<boolean> {
  const current = await latestConsent(userId, pilotId, "telemetry");
  return currentConsentGranted(current) && current.id === consentId;
}

/**
 * Normal Ask Jack usage is a meaningful foreground pilot action. When the actor
 * is an unambiguous active tester who has already granted the current optional
 * telemetry consent, make sure that usage has one canonical active test session
 * before the chat route records its server-authoritative Ask Jack event.
 *
 * This helper never grants consent, never guesses between pilots, never replaces
 * an explicit valid session hint, and fails closed when an existing session is
 * tied to stale consent. The explicit /testing/sessions/start route remains the
 * richer lifecycle surface for resume/expiry transitions; this path only closes
 * the zero-session attribution gap for normal field use.
 */
export async function ensureAskJackTelemetrySession(
  req: Request,
  actorIdentity: CallerIdentity | null,
): Promise<void> {
  if (
    !actorIdentity ||
    actorIdentity.isAdmin ||
    isUnavailableIdentity(actorIdentity) ||
    isPresentationIdentity(actorIdentity) ||
    hasValidSessionHint(req)
  ) {
    return;
  }

  const actorUserId = actorIdentity.userId;
  const membership = await resolveActiveTesterScope(actorUserId);
  if (!membership.scope) return;

  const { organizationId, pilotId } = membership.scope;
  const telemetryConsent = await latestConsent(actorUserId, pilotId, "telemetry");
  if (!currentConsentGranted(telemetryConsent)) return;

  const existing = await activeScopedSessions(actorUserId, pilotId);
  if (existing.error) throw existing.error;
  if ((existing.data ?? []).length > 1) return;

  if (existing.data?.length === 1) {
    const session = existing.data[0] as Record<string, any>;
    if (!sessionUsesExactTelemetryConsent(session, telemetryConsent.id)) return;
    req.headers["x-jack-test-session-id"] = String(session.id);
    return;
  }

  const [screenConsent, microphoneConsent] = await Promise.all([
    latestConsent(actorUserId, pilotId, "screen"),
    latestConsent(actorUserId, pilotId, "microphone"),
  ]);
  const now = new Date().toISOString();
  const sessionId = randomUUID();
  const sessionRow = {
    id: sessionId,
    actor_user_id: actorUserId,
    organization_id: organizationId,
    pilot_id: pilotId,
    app_session_id: randomUUID(),
    device_category: deviceCategory(req.headers["user-agent"]),
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
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    created_at: now,
    updated_at: now,
  };

  const inserted = await db
    .from("test_sessions")
    .insert(sessionRow)
    .select("*")
    .single();

  let session = inserted.data as Record<string, any> | null;
  if (inserted.error) {
    if ((inserted.error as { code?: string }).code !== "23505") {
      throw inserted.error;
    }
    const raced = await activeScopedSessions(actorUserId, pilotId);
    if (raced.error) throw raced.error;
    if ((raced.data ?? []).length !== 1) return;
    session = raced.data[0] as Record<string, any>;
    if (!sessionUsesExactTelemetryConsent(session, telemetryConsent.id)) return;
  }
  if (!session) return;

  if (!(await telemetryConsentStillCurrent(actorUserId, pilotId, telemetryConsent.id))) {
    await compensateTelemetryWriteAfterWithdrawal(
      actorUserId,
      pilotId,
      String(session.id),
    );
    return;
  }

  req.headers["x-jack-test-session-id"] = String(session.id);
}

export async function askJackTelemetrySessionMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  if (req.method !== "POST" || req.path !== "/chat") {
    next();
    return;
  }

  try {
    await ensureAskJackTelemetrySession(req, await resolveIdentity(req));
  } catch (error) {
    // Telemetry is optional and must never make Ask Jack unavailable. The
    // downstream server event writer remains fail-closed if no valid session
    // hint was established here.
    req.log?.warn({ err: error }, "Ask Jack telemetry session ensure failed");
  }
  next();
}
