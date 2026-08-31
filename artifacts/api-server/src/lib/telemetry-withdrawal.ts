import { randomUUID } from "node:crypto";
import { logger } from "./logger.js";
import { supabase } from "./supabase.js";

const db = supabase as unknown as {
  from: (table: string) => any;
  rpc: (name: string, params: Record<string, unknown>) => Promise<{
    data: unknown;
    error: { message?: string } | null;
  }>;
};

const WITHDRAWAL_JOB_TABLE = "telemetry_withdrawal_jobs";
const WITHDRAWAL_JOB_BATCH_SIZE = 100;
const WITHDRAWAL_JOB_LEASE_MS = 5 * 60 * 1000;
const WITHDRAWAL_JOB_SWEEP_INTERVAL_MS = 60 * 1000;
const MAX_RETRY_DELAY_MS = 6 * 60 * 60 * 1000;
const UNCOMMITTED_MANIFEST_GRACE_MS = 24 * 60 * 60 * 1000;
const VALID_SCOPES = new Set(["telemetry", "screen", "microphone"]);

export type TelemetryWithdrawalScope = "telemetry" | "screen" | "microphone";

export interface TelemetryWithdrawalJobInput {
  id: string;
  actorUserId: string;
  organizationId: string;
  pilotId: string;
  scopes: TelemetryWithdrawalScope[];
  consentIds: string[];
  consentRetainedUntil: string;
  deletionDueAt: string;
  privacyNoticeVersion: string;
  consentVersion: string;
}

export interface TelemetryWithdrawalReconcileResult {
  status: "completed" | "pending" | "skipped";
  manifestCommitted?: boolean;
  error?: string;
}

class UncommittedWithdrawalManifestError extends Error {
  constructor() {
    super("withdrawal_consents_not_yet_committed");
    this.name = "UncommittedWithdrawalManifestError";
  }
}

function isoAfterMs(milliseconds: number, from = Date.now()): string {
  return new Date(from + milliseconds).toISOString();
}

function safeError(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error && "message" in error
        ? String((error as { message?: unknown }).message)
        : String(error);
  return message.slice(0, 500);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function retryDelayMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), MAX_RETRY_DELAY_MS);
}

export async function appendTelemetryWithdrawal(
  input: TelemetryWithdrawalJobInput,
): Promise<string | null> {
  if (
    input.scopes.length === 0 ||
    input.scopes.length !== input.consentIds.length ||
    input.scopes.some((scope) => !VALID_SCOPES.has(scope)) ||
    new Set(input.scopes).size !== input.scopes.length ||
    (input.scopes.includes("telemetry") &&
      (!input.scopes.includes("screen") || !input.scopes.includes("microphone")))
  ) {
    throw new Error("Invalid telemetry withdrawal cleanup obligation.");
  }

  const result = await db.rpc("append_telemetry_withdrawal", {
    p_job_id: input.id,
    p_actor_user_id: input.actorUserId,
    p_organization_id: input.organizationId,
    p_pilot_id: input.pilotId,
    p_scopes: input.scopes,
    p_consent_ids: input.consentIds,
    p_consent_retained_until: input.consentRetainedUntil,
    p_deletion_due_at: input.deletionDueAt,
    p_privacy_notice_version: input.privacyNoticeVersion,
    p_consent_version: input.consentVersion,
  });
  if (result.error) throw result.error;
  return typeof result.data === "string" ? result.data : null;
}

async function verifyCommittedWithdrawal(job: Record<string, unknown>): Promise<void> {
  const scopes = stringArray(job["scopes"]);
  const consentIds = stringArray(job["consent_ids"]);
  if (scopes.length === 0 || scopes.length !== consentIds.length) {
    throw new Error("withdrawal_job_invalid_consent_manifest");
  }

  const consents = await db
    .from("telemetry_consents")
    .select("id,actor_user_id,organization_id,pilot_id,scope,state")
    .in("id", consentIds);
  if (consents.error) throw consents.error;

  if ((consents.data ?? []).length === 0) {
    throw new UncommittedWithdrawalManifestError();
  }
  const byId = new Map<string, Record<string, unknown>>(
    (consents.data ?? []).map((row: Record<string, unknown>) => [String(row["id"]), row]),
  );
  for (const [index, consentId] of consentIds.entries()) {
    const consent = byId.get(consentId);
    if (
      !consent ||
      consent["actor_user_id"] !== job["actor_user_id"] ||
      consent["organization_id"] !== job["organization_id"] ||
      consent["pilot_id"] !== job["pilot_id"] ||
      consent["scope"] !== scopes[index] ||
      consent["state"] !== "withdrawn"
    ) {
      throw new Error("withdrawal_consent_manifest_mismatch");
    }
  }
}

type ConsentEpochs = Record<TelemetryWithdrawalScope, string[]>;

interface RowEpochs {
  known: boolean;
  activityIngestFailures: string[];
  testFeedback: string[];
  testRecordings: string[];
}

function epochIdsFromJob(job: Record<string, unknown>): ConsentEpochs | null {
  const raw = job["epoch_consent_ids"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  return {
    telemetry: stringArray(value["telemetry"]),
    screen: stringArray(value["screen"]),
    microphone: stringArray(value["microphone"]),
  };
}

function rowEpochsFromJob(job: Record<string, unknown>): RowEpochs {
  const raw = job["epoch_row_ids"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      known: false,
      activityIngestFailures: [],
      testFeedback: [],
      testRecordings: [],
    };
  }
  const value = raw as Record<string, unknown>;
  return {
    known: true,
    activityIngestFailures: stringArray(value["activity_ingest_failures"]),
    testFeedback: stringArray(value["test_feedback"]),
    testRecordings: stringArray(value["test_recordings"]),
  };
}

async function loadConsentEpochs(
  job: Record<string, unknown>,
): Promise<ConsentEpochs> {
  const recorded = epochIdsFromJob(job);
  if (recorded) return recorded;

  // Defensive compatibility for an obligation staged before lineage snapshots
  // existed. New obligations always carry epoch_consent_ids from the atomic RPC.
  const epochs: ConsentEpochs = {
    telemetry: [],
    screen: [],
    microphone: [],
  };
  for (const scope of stringArray(job["scopes"]) as TelemetryWithdrawalScope[]) {
    const grants = await db
      .from("telemetry_consents")
      .select("id")
      .eq("actor_user_id", job["actor_user_id"])
      .eq("organization_id", job["organization_id"])
      .eq("pilot_id", job["pilot_id"])
      .eq("scope", scope)
      .eq("state", "granted")
      .lte("occurred_at", job["withdrawn_at"]);
    if (grants.error) throw grants.error;
    epochs[scope] = (grants.data ?? [])
      .map((row: Record<string, unknown>) => row["id"])
      .filter((id: unknown): id is string => typeof id === "string");
  }
  return epochs;
}

async function updateRecordingsForSessions(
  actorUserId: string,
  sessionIds: string[],
  deletionDueAt: string,
): Promise<void> {
  if (sessionIds.length === 0) return;
  const recordings = await db
    .from("test_recordings")
    .update({ deletion_due_at: deletionDueAt })
    .eq("tester_user_id", actorUserId)
    .in("test_session_id", sessionIds);
  if (recordings.error) throw recordings.error;
}

async function updateRecordingsForConsentIds(
  actorUserId: string,
  pilotId: string,
  column: "screen_consent_id" | "microphone_consent_id",
  consentIds: string[],
  deletionDueAt: string,
): Promise<void> {
  if (consentIds.length === 0) return;
  const recordings = await db
    .from("test_recordings")
    .update({ deletion_due_at: deletionDueAt })
    .eq("tester_user_id", actorUserId)
    .eq("pilot_id", pilotId)
    .in(column, consentIds);
  if (recordings.error) throw recordings.error;
}

async function applyTelemetryWithdrawalCleanup(
  job: Record<string, unknown>,
): Promise<void> {
  const actorUserId = String(job["actor_user_id"]);
  const pilotId = String(job["pilot_id"]);
  const withdrawnAt = String(job["withdrawn_at"]);
  const deletionDueAt = String(job["deletion_due_at"]);
  const consentRetainedUntil = String(job["consent_retained_until"]);
  const scopes = new Set(stringArray(job["scopes"]));
  const epochs = await loadConsentEpochs(job);
  const rowEpochs = rowEpochsFromJob(job);

  const consentHistoryIds = [
    ...new Set([
      ...stringArray(job["consent_ids"]),
      ...epochs.telemetry,
      ...epochs.screen,
      ...epochs.microphone,
    ]),
  ];
  if (consentHistoryIds.length > 0) {
    const consentHistory = await db
      .from("telemetry_consents")
      .update({ retained_until: consentRetainedUntil })
      .eq("actor_user_id", actorUserId)
      .eq("pilot_id", pilotId)
      .in("id", consentHistoryIds)
      .lt("retained_until", consentRetainedUntil);
    if (consentHistory.error) throw consentHistory.error;
  }

  let sessionIds: string[] = [];
  if (epochs.telemetry.length > 0) {
    const sessions = await db
      .from("test_sessions")
      .select("id")
      .eq("actor_user_id", actorUserId)
      .eq("pilot_id", pilotId)
      .in("telemetry_consent_id", epochs.telemetry);
    if (sessions.error) throw sessions.error;
    sessionIds = (sessions.data ?? [])
      .map((row: Record<string, unknown>) => row["id"])
      .filter((id: unknown): id is string => typeof id === "string");
  }

  if (scopes.has("telemetry")) {
    if (epochs.telemetry.length > 0) {
      const sessionUpdate = await db
        .from("test_sessions")
        .update({
          status: "withdrawn",
          telemetry_status: "withdrawn",
          screen_consent_state: "withdrawn",
          microphone_consent_state: "withdrawn",
          recording_status: "withdrawn",
          deletion_due_at: deletionDueAt,
          updated_at: withdrawnAt,
        })
        .eq("actor_user_id", actorUserId)
        .eq("pilot_id", pilotId)
        .in("telemetry_consent_id", epochs.telemetry);
      if (sessionUpdate.error) throw sessionUpdate.error;

      const eventUpdate = await db
        .from("test_events")
        .update({
          metadata: {},
          correlation_id: null,
          request_id: null,
          redacted_at: withdrawnAt,
          deletion_due_at: deletionDueAt,
        })
        .eq("actor_user_id", actorUserId)
        .eq("pilot_id", pilotId)
        .in("consent_id", epochs.telemetry);
      if (eventUpdate.error) throw eventUpdate.error;
    }

    let failureDelete = db
      .from("activity_ingest_failures")
      .delete()
      .eq("actor_user_id", actorUserId)
      .eq("pilot_id", pilotId);
    if (rowEpochs.known) {
      if (rowEpochs.activityIngestFailures.length > 0) {
        failureDelete = failureDelete.in("id", rowEpochs.activityIngestFailures);
        const failures = await failureDelete;
        if (failures.error) throw failures.error;
      }
    } else {
      failureDelete = failureDelete.lte("created_at", withdrawnAt);
      const failures = await failureDelete;
      if (failures.error) throw failures.error;
    }

    if (rowEpochs.known && rowEpochs.testRecordings.length > 0) {
      const recordings = await db
        .from("test_recordings")
        .update({ deletion_due_at: deletionDueAt })
        .eq("tester_user_id", actorUserId)
        .in("id", rowEpochs.testRecordings);
      if (recordings.error) throw recordings.error;
    } else if (!rowEpochs.known) {
      const recordings = await db
        .from("test_recordings")
        .update({ deletion_due_at: deletionDueAt })
        .eq("tester_user_id", actorUserId)
        .eq("pilot_id", pilotId)
        .lte("created_at", withdrawnAt);
      if (recordings.error) throw recordings.error;
    }
    await updateRecordingsForSessions(actorUserId, sessionIds, deletionDueAt);
    await updateRecordingsForConsentIds(
      actorUserId,
      pilotId,
      "screen_consent_id",
      epochs.screen,
      deletionDueAt,
    );
    await updateRecordingsForConsentIds(
      actorUserId,
      pilotId,
      "microphone_consent_id",
      epochs.microphone,
      deletionDueAt,
    );

    const feedbackValues = {
      deletion_due_at: deletionDueAt,
      notification_status: "failed",
      notification_last_error: "telemetry_consent_withdrawn",
      notification_next_attempt_at: null,
      updated_at: withdrawnAt,
    };
    if (rowEpochs.known && rowEpochs.testFeedback.length > 0) {
      const feedback = await db
        .from("test_feedback")
        .update(feedbackValues)
        .eq("tester_user_id", actorUserId)
        .in("id", rowEpochs.testFeedback);
      if (feedback.error) throw feedback.error;
    } else if (!rowEpochs.known) {
      const feedback = await db
        .from("test_feedback")
        .update(feedbackValues)
        .eq("tester_user_id", actorUserId)
        .eq("pilot_id", pilotId)
        .lte("created_at", withdrawnAt);
      if (feedback.error) throw feedback.error;
    }
    return;
  }

  // Separate scope-specific compare-and-swap updates eliminate the read/update
  // window: a session rebound to a new grant ID cannot match an old epoch ID.
  if (scopes.has("screen") && epochs.screen.length > 0) {
    const screenSessions = await db
      .from("test_sessions")
      .update({
        screen_consent_state: "withdrawn",
        recording_status: "withdrawn",
        updated_at: withdrawnAt,
      })
      .eq("actor_user_id", actorUserId)
      .eq("pilot_id", pilotId)
      .eq("status", "active")
      .in("screen_consent_id", epochs.screen);
    if (screenSessions.error) throw screenSessions.error;
    await updateRecordingsForConsentIds(
      actorUserId,
      pilotId,
      "screen_consent_id",
      epochs.screen,
      deletionDueAt,
    );
    if (rowEpochs.known && rowEpochs.testRecordings.length > 0) {
      const recordings = await db
        .from("test_recordings")
        .update({ deletion_due_at: deletionDueAt })
        .eq("tester_user_id", actorUserId)
        .in("id", rowEpochs.testRecordings);
      if (recordings.error) throw recordings.error;
    }
  }

  if (scopes.has("microphone") && epochs.microphone.length > 0) {
    const microphoneSessions = await db
      .from("test_sessions")
      .update({
        microphone_consent_state: "withdrawn",
        recording_status: "withdrawn",
        updated_at: withdrawnAt,
      })
      .eq("actor_user_id", actorUserId)
      .eq("pilot_id", pilotId)
      .eq("status", "active")
      .in("microphone_consent_id", epochs.microphone);
    if (microphoneSessions.error) throw microphoneSessions.error;
    await updateRecordingsForConsentIds(
      actorUserId,
      pilotId,
      "microphone_consent_id",
      epochs.microphone,
      deletionDueAt,
    );
  }
}

async function claimJob(
  job: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const status = String(job["status"]);
  const leaseExpiresAt = Date.parse(String(job["lease_expires_at"] ?? ""));
  if (
    status === "processing" &&
    Number.isFinite(leaseExpiresAt) &&
    leaseExpiresAt > Date.now()
  ) {
    return null;
  }
  if (
    !["awaiting_consent", "pending", "retrying", "processing"].includes(status)
  ) {
    return null;
  }

  const now = new Date().toISOString();
  const leaseToken = randomUUID();
  const claimed = await db
    .from(WITHDRAWAL_JOB_TABLE)
    .update({
      status: "processing",
      attempts: Number(job["attempts"] ?? 0) + 1,
      lease_token: leaseToken,
      lease_expires_at: isoAfterMs(WITHDRAWAL_JOB_LEASE_MS),
      updated_at: now,
    })
    .eq("id", job["id"])
    .eq("status", status)
    .eq("updated_at", job["updated_at"])
    .select("*")
    .maybeSingle();
  if (claimed.error) throw claimed.error;
  return claimed.data ?? null;
}

async function completeJob(job: Record<string, unknown>): Promise<void> {
  const now = new Date().toISOString();
  const completed = await db
    .from(WITHDRAWAL_JOB_TABLE)
    .update({
      status: "completed",
      completed_at: now,
      retained_until: isoAfterMs(90 * 24 * 60 * 60 * 1000),
      next_attempt_at: null,
      lease_token: null,
      lease_expires_at: null,
      last_error: null,
      updated_at: now,
    })
    .eq("id", job["id"])
    .eq("status", "processing")
    .eq("lease_token", job["lease_token"]);
  if (completed.error) throw completed.error;
}

async function cancelStaleUncommittedJob(
  job: Record<string, unknown>,
): Promise<boolean> {
  const withdrawnAt = Date.parse(String(job["withdrawn_at"] ?? ""));
  if (
    !Number.isFinite(withdrawnAt) ||
    Date.now() - withdrawnAt < UNCOMMITTED_MANIFEST_GRACE_MS
  ) {
    return false;
  }

  const now = new Date().toISOString();
  const cancelled = await db
    .from(WITHDRAWAL_JOB_TABLE)
    .update({
      status: "cancelled",
      completed_at: now,
      retained_until: isoAfterMs(90 * 24 * 60 * 60 * 1000),
      next_attempt_at: null,
      lease_token: null,
      lease_expires_at: null,
      last_error: "authoritative_withdrawal_manifest_absent",
      updated_at: now,
    })
    .eq("id", job["id"])
    .eq("status", "processing")
    .eq("lease_token", job["lease_token"])
    .select("id")
    .maybeSingle();
  if (cancelled.error) throw cancelled.error;
  return Boolean(cancelled.data);
}

async function retryJob(
  job: Record<string, unknown>,
  error: unknown,
): Promise<void> {
  const now = new Date().toISOString();
  const attempts = Number(job["attempts"] ?? 1);
  const retry = await db
    .from(WITHDRAWAL_JOB_TABLE)
    .update({
      status: "retrying",
      next_attempt_at: isoAfterMs(retryDelayMs(attempts)),
      lease_token: null,
      lease_expires_at: null,
      last_error: safeError(error),
      updated_at: now,
    })
    .eq("id", job["id"])
    .eq("status", "processing")
    .eq("lease_token", job["lease_token"]);
  if (retry.error) throw retry.error;
}

export async function reconcileTelemetryWithdrawalJob(
  jobId: string,
): Promise<TelemetryWithdrawalReconcileResult> {
  const loaded = await db
    .from(WITHDRAWAL_JOB_TABLE)
    .select("*")
    .eq("id", jobId)
    .maybeSingle();
  if (loaded.error) throw loaded.error;
  if (!loaded.data) return { status: "skipped" };
  if (loaded.data.status === "completed") {
    return { status: "completed", manifestCommitted: true };
  }
  if (loaded.data.status === "cancelled") return { status: "skipped" };

  const claimed = await claimJob(loaded.data);
  if (!claimed) return { status: "pending" };

  let manifestVerified = false;
  try {
    await verifyCommittedWithdrawal(claimed);
    manifestVerified = true;
    await applyTelemetryWithdrawalCleanup(claimed);
    await completeJob(claimed);
    return { status: "completed", manifestCommitted: true };
  } catch (error) {
    if (error instanceof UncommittedWithdrawalManifestError) {
      try {
        if (await cancelStaleUncommittedJob(claimed)) {
          return { status: "skipped", manifestCommitted: false };
        }
      } catch (cancelError) {
        logger.error(
          { err: cancelError, withdrawalJobId: jobId },
          "Could not cancel stale uncommitted withdrawal obligation",
        );
      }
    }
    try {
      await retryJob(claimed, error);
    } catch (retryError) {
      logger.error(
        { err: retryError, withdrawalJobId: jobId },
        "Could not release telemetry withdrawal cleanup lease",
      );
    }
    return {
      status: "pending",
      manifestCommitted: manifestVerified,
      error: safeError(error),
    };
  }
}

async function purgeExpiredWithdrawalJobs(now: string): Promise<number> {
  const expired = await db
    .from(WITHDRAWAL_JOB_TABLE)
    .select("id")
    .in("status", ["completed", "cancelled"])
    .lt("retained_until", now)
    .limit(WITHDRAWAL_JOB_BATCH_SIZE);
  if (expired.error) throw expired.error;
  const ids = (expired.data ?? [])
    .map((row: Record<string, unknown>) => row["id"])
    .filter((id: unknown): id is string => typeof id === "string");
  if (ids.length === 0) return 0;
  const removed = await db.from(WITHDRAWAL_JOB_TABLE).delete().in("id", ids);
  if (removed.error) throw removed.error;
  return ids.length;
}

export async function runTelemetryWithdrawalSweep(): Promise<{
  attempted: number;
  completed: number;
  pending: number;
  expired: number;
}> {
  const now = new Date().toISOString();
  const expiredCount = await purgeExpiredWithdrawalJobs(now);
  const [due, expired] = await Promise.all([
    db
      .from(WITHDRAWAL_JOB_TABLE)
      .select("*")
      .in("status", ["awaiting_consent", "pending", "retrying"])
      .lt("next_attempt_at", now)
      .limit(WITHDRAWAL_JOB_BATCH_SIZE),
    db
      .from(WITHDRAWAL_JOB_TABLE)
      .select("*")
      .eq("status", "processing")
      .lt("lease_expires_at", now)
      .limit(WITHDRAWAL_JOB_BATCH_SIZE),
  ]);
  if (due.error) throw due.error;
  if (expired.error) throw expired.error;

  const jobs = new Map<string, Record<string, unknown>>();
  for (const row of [...(due.data ?? []), ...(expired.data ?? [])]) {
    jobs.set(String(row["id"]), row);
  }

  let completed = 0;
  let pending = 0;
  for (const jobId of jobs.keys()) {
    const result = await reconcileTelemetryWithdrawalJob(jobId);
    if (result.status === "completed") completed += 1;
    else pending += 1;
  }
  return { attempted: jobs.size, completed, pending, expired: expiredCount };
}

export function startTelemetryWithdrawalWorker(): { stop: () => void } {
  if (process.env["TELEMETRY_WITHDRAWAL_RECONCILER_ENABLED"] === "false") {
    logger.info("telemetry withdrawal reconciler disabled");
    return { stop: () => {} };
  }

  const sweep = () => {
    void runTelemetryWithdrawalSweep()
      .then((counts) =>
        logger.info({ counts }, "telemetry withdrawal reconciliation completed"),
      )
      .catch((error) =>
        logger.error({ err: error }, "telemetry withdrawal reconciliation failed"),
      );
  };
  sweep();
  const timer = setInterval(sweep, WITHDRAWAL_JOB_SWEEP_INTERVAL_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
