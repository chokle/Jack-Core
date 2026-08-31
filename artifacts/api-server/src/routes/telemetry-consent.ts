import { randomUUID } from "node:crypto";
import { Router } from "express";
import { resolveIdentity } from "../lib/admin-auth.js";
import { denyRestrictedIdentity } from "../lib/identity.js";
import {
  activityDb as db,
  CONSENT_VERSION,
  currentConsentGranted,
  latestConsent,
  PRIVACY_NOTICE_VERSION,
  resolveActiveTesterScope,
  WITHDRAWAL_DELETION_DAYS,
} from "../lib/activity-telemetry.js";
import {
  appendTelemetryWithdrawal,
  reconcileTelemetryWithdrawalJob,
  type TelemetryWithdrawalScope,
} from "../lib/telemetry-withdrawal.js";

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

interface PrivacyConsentSnapshot {
  id: string;
  state: "granted" | "declined" | "withdrawn";
  privacyNoticeVersion: string;
  consentVersion: string;
}

interface TelemetryPrivacyScope {
  organizationId: string;
  pilotId: string;
  organizationName?: string;
  pilotName?: string;
  consents: {
    telemetry: PrivacyConsentSnapshot | null;
    screen: PrivacyConsentSnapshot | null;
    microphone: PrivacyConsentSnapshot | null;
  };
}

async function historicalPrivacyScopes(userId: string): Promise<TelemetryPrivacyScope[]> {
  const history = await db
    .from("telemetry_consents")
    .select("id,actor_user_id,organization_id,pilot_id,scope,state,privacy_notice_version,consent_version,occurred_at,consent_sequence")
    .eq("actor_user_id", userId)
    .order("occurred_at", { ascending: false })
    .order("consent_sequence", { ascending: false });
  if (history.error) throw history.error;

  const pilotIds = [...new Set(
    (history.data ?? [])
      .map((row: Record<string, unknown>) => row["pilot_id"])
      .filter((id: unknown): id is string => typeof id === "string"),
  )];
  const pilots = pilotIds.length > 0
    ? await db.from("pilots").select("id,organization_id,name").in("id", pilotIds)
    : { data: [], error: null };
  if (pilots.error) throw pilots.error;
  const pilotById = new Map<string, Record<string, unknown>>(
    (pilots.data ?? []).map((row: Record<string, unknown>) => [String(row["id"]), row]),
  );

  const organizationIds = [...new Set(
    (history.data ?? [])
      .map((row: Record<string, unknown>) => row["organization_id"])
      .filter((id: unknown): id is string => typeof id === "string"),
  )];
  const organizations = organizationIds.length > 0
    ? await db.from("organizations").select("id,name").in("id", organizationIds)
    : { data: [], error: null };
  if (organizations.error) throw organizations.error;
  const organizationById = new Map<string, Record<string, unknown>>(
    (organizations.data ?? []).map(
      (row: Record<string, unknown>) => [String(row["id"]), row],
    ),
  );

  const scopes = new Map<string, TelemetryPrivacyScope>();
  for (const row of history.data ?? []) {
    const pilotId = String(row["pilot_id"] ?? "");
    const organizationId = String(row["organization_id"] ?? "");
    const consentScope = String(row["scope"]);
    if (
      !UUID_RE.test(pilotId) ||
      !UUID_RE.test(organizationId) ||
      !["telemetry", "screen", "microphone"].includes(consentScope)
    ) {
      continue;
    }

    let privacyScope = scopes.get(pilotId);
    if (!privacyScope) {
      const pilot = pilotById.get(pilotId);
      const organization = organizationById.get(organizationId);
      privacyScope = {
        organizationId,
        pilotId,
        ...(organization?.["name"]
          ? { organizationName: String(organization["name"]) }
          : {}),
        ...(pilot?.["name"] ? { pilotName: String(pilot["name"]) } : {}),
        consents: { telemetry: null, screen: null, microphone: null },
      };
      scopes.set(pilotId, privacyScope);
    }

    const key = consentScope as TelemetryWithdrawalScope;
    if (privacyScope.consents[key]) continue;
    privacyScope.consents[key] = {
      id: String(row["id"]),
      state: row["state"] as PrivacyConsentSnapshot["state"],
      privacyNoticeVersion: String(row["privacy_notice_version"] ?? ""),
      consentVersion: String(row["consent_version"] ?? ""),
    };
  }
  return [...scopes.values()];
}

async function currentContext(userId: string, requestedPilotId?: string | null) {
  const [membership, privacyScopes] = await Promise.all([
    resolveActiveTesterScope(userId, requestedPilotId),
    historicalPrivacyScopes(userId),
  ]);
  if (!membership.scope) {
    return {
      enrolled: false,
      requiresPilotSelection: membership.reason === "ambiguous_pilot",
      scope: null,
      privacyScopes,
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
  const activePrivacyScope = privacyScopes.find(
    (scope) => scope.pilotId === membership.scope!.pilotId,
  );
  if (activePrivacyScope) {
    activePrivacyScope.consents = { telemetry, screen, microphone };
  } else {
    privacyScopes.unshift({
      organizationId: membership.scope.organizationId,
      pilotId: membership.scope.pilotId,
      ...(membership.scope.pilotName
        ? { pilotName: membership.scope.pilotName }
        : {}),
      consents: { telemetry, screen, microphone },
    });
  }

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
    privacyScopes,
    consents: { telemetry, screen, microphone },
    session:
      session.data &&
      session.data.telemetry_status === "granted" &&
      currentConsentGranted(telemetry) &&
      String(session.data.telemetry_consent_id) === telemetry.id
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

async function withdrawalScope(
  userId: string,
  pilotId: string | null,
  historicalOnly = false,
) {
  if (!historicalOnly) {
    const activeMembership = await resolveActiveTesterScope(userId, pilotId);
    if (activeMembership.scope) return activeMembership.scope;
  }
  if (!pilotId) return null;
  const historicalConsent = await db
    .from("telemetry_consents")
    .select("*")
    .eq("actor_user_id", userId)
    .eq("pilot_id", pilotId)
    .order("occurred_at", { ascending: false })
    .order("consent_sequence", { ascending: false })
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
    if (
      denyRestrictedIdentity(
        res,
        identity,
        "Pilot telemetry is unavailable for this account.",
        "Telemetry preferences are temporarily unavailable.",
      )
    ) return;
    if (identity.isAdmin) {
      return res.json({
        enrolled: false,
        requiresPilotSelection: false,
        scope: null,
        privacyScopes: await historicalPrivacyScopes(identity.userId),
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
    if (
      denyRestrictedIdentity(
        res,
        identity,
        "Pilot telemetry is unavailable for this account.",
        "Telemetry preferences are temporarily unavailable.",
      )
    ) return;
    if (identity.isAdmin) {
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
    if (
      denyRestrictedIdentity(
        res,
        identity,
        "Pilot telemetry is unavailable for this account.",
        "Telemetry preferences are temporarily unavailable.",
      )
    ) return;
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
    const scopes = new Set<TelemetryWithdrawalScope>(
      requestedScopes.map(String) as TelemetryWithdrawalScope[],
    );
    if (scopes.has("telemetry")) {
      scopes.add("screen");
      scopes.add("microphone");
    }
    // Admin promotion never enables collection or new consent. It does not
    // erase the person's right to act on consent history they own.
    const scope = await withdrawalScope(
      identity.userId,
      pilotId,
      identity.isAdmin,
    );
    if (!scope) return res.status(404).json({ error: "Pilot consent history not found." });

    const retainedUntil = new Date(
      new Date().setUTCMonth(new Date().getUTCMonth() + 24),
    ).toISOString();
    const deletionDueAt = isoAfterDays(WITHDRAWAL_DELETION_DAYS);
    const withdrawalJobId = randomUUID();
    const withdrawalScopes = [...scopes];
    const consentIds = withdrawalScopes.map(() => randomUUID());

    // The database function takes the same per-actor lock as whole-account
    // deletion and atomically appends the authoritative withdrawal rows with
    // their durable cleanup obligation. There is no job-without-consent state.
    let appendReportedError: unknown = null;
    try {
      await appendTelemetryWithdrawal({
        id: withdrawalJobId,
        actorUserId: identity.userId,
        organizationId: scope.organizationId,
        pilotId: scope.pilotId,
        scopes: withdrawalScopes,
        consentIds,
        consentRetainedUntil: retainedUntil,
        deletionDueAt,
        privacyNoticeVersion: PRIVACY_NOTICE_VERSION,
        consentVersion: CONSENT_VERSION,
      });
    } catch (error) {
      // A transport failure can still be ambiguous after commit. Reconcile the
      // exact job/manifest once; absence is an actionable failure, never a 202
      // that would leave collection authorized.
      appendReportedError = error;
      req.log.error(
        { err: error, withdrawalJobId },
        "Atomic telemetry withdrawal append result is ambiguous",
      );
    }

    let cleanupPending = true;
    let manifestCommitted = appendReportedError === null;
    try {
      const reconciliation = await reconcileTelemetryWithdrawalJob(withdrawalJobId);
      cleanupPending = reconciliation.status !== "completed";
      manifestCommitted =
        manifestCommitted || reconciliation.manifestCommitted === true;
      if (reconciliation.error) {
        req.log.error(
          { err: reconciliation.error, withdrawalJobId },
          "Telemetry withdrawal cleanup is pending retry",
        );
      }
    } catch (reconcileError) {
      req.log.error(
        { err: reconcileError, withdrawalJobId },
        "Telemetry withdrawal cleanup is pending durable reconciliation",
      );
    }

    if (!manifestCommitted) {
      return res.status(503).json({
        error:
          "Telemetry withdrawal could not be confirmed. Collection remains stopped; retry the withdrawal.",
        withdrawalJobId,
      });
    }

    return res.status(cleanupPending ? 202 : 200).json({
      withdrawn: withdrawalScopes,
      requestedWithdrawal: withdrawalScopes,
      deletionDueAt:
        scopes.has("telemetry") || scopes.has("screen") ? deletionDueAt : null,
      cleanupPending,
      withdrawalPending: false,
      withdrawalJobId,
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
    if (
      denyRestrictedIdentity(
        res,
        identity,
        "Pilot telemetry is unavailable for this account.",
        "Telemetry export is temporarily unavailable.",
      )
    ) return;
    const [
      consents,
      withdrawalJobs,
      sessions,
      events,
      failures,
      recordings,
      feedback,
    ] = await Promise.all([
      db.from("telemetry_consents").select("*").eq("actor_user_id", identity.userId),
      db
        .from("telemetry_withdrawal_jobs")
        .select("id,organization_id,pilot_id,scopes,withdrawn_at,deletion_due_at,status,attempts,completed_at,created_at,updated_at")
        .eq("actor_user_id", identity.userId),
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
    const failed = [
      consents,
      withdrawalJobs,
      sessions,
      events,
      failures,
      recordings,
      feedback,
    ].find((result) => result.error);
    if (failed?.error) throw failed.error;
    res.setHeader("Content-Disposition", 'attachment; filename="jack-telemetry-export.json"');
    res.setHeader("Cache-Control", "no-store");
    return res.json({
      exportedAt: new Date().toISOString(),
      notice:
        "Ask Jack conversation history is product data and is not duplicated in this optional telemetry export.",
      consents: consents.data ?? [],
      withdrawalJobs: (withdrawalJobs.data ?? []).map(
        (row: Record<string, unknown>) => ({
          id: row["id"],
          organizationId: row["organization_id"],
          pilotId: row["pilot_id"],
          scopes: row["scopes"],
          withdrawnAt: row["withdrawn_at"],
          deletionDueAt: row["deletion_due_at"],
          status: row["status"],
          attempts: row["attempts"],
          completedAt: row["completed_at"],
          createdAt: row["created_at"],
          updatedAt: row["updated_at"],
        }),
      ),
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
