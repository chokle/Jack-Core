import { randomUUID } from "node:crypto";
import { logger } from "./logger.js";
import { supabase } from "./supabase.js";

const db = supabase as unknown as {
  from: (table: string) => any;
};

const WITHDRAWAL_JOB_TABLE = "telemetry_withdrawal_jobs";
const WITHDRAWAL_JOB_BATCH_SIZE = 100;
const WITHDRAWAL_JOB_LEASE_MS = 5 * 60 * 1000;
const WITHDRAWAL_JOB_SWEEP_INTERVAL_MS = 60 * 1000;
const MAX_RETRY_DELAY_MS = 6 * 60 * 60 * 1000;
const VALID_SCOPES = new Set(["telemetry", "screen", "microphone"]);

export type TelemetryWithdrawalScope = "telemetry" | "screen" | "microphone";

export interface TelemetryWithdrawalJobInput {
  id: string;
  actorUserId: string;
  organizationId: string;
  pilotId: string;
  scopes: TelemetryWithdrawalScope[];
  consentIds: string[];
  withdrawnAt: string;
  consentRetainedUntil: string;
  deletionDueAt: string;
}

export interface TelemetryWithdrawalReconcileResult {
  status: "completed" | "pending" | "skipped";
  error?: string;
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

export async function enqueueTelemetryWithdrawalJob(
  input: TelemetryWithdrawalJobInput,
): Promise<void> {
  if (
    input.scopes.length === 0 ||
    input.scopes.length !== input.consentIds.length ||
    input.scopes.some((scope) => !VALID_SCOPES.has(scope))
  ) {
    throw new Error("Invalid telemetry withdrawal cleanup obligation.");
  }

  const inserted = await db.from(WITHDRAWAL_JOB_TABLE).insert({
    id: input.id,
    actor_user_id: input.actorUserId,
    organization_id: input.organizationId,
    pilot_id: input.pilotId,
    scopes: input.scopes,
    consent_ids: input.consentIds,
    withdrawn_at: input.withdrawnAt,
    consent_retained_until: input.consentRetainedUntil,
    deletion_due_at: input.deletionDueAt,
    status: "awaiting_consent",
    attempts: 0,
    next_attempt_at: input.withdrawnAt,
    created_at: input.withdrawnAt,
    updated_at: input.withdrawnAt,
  });
  if (inserted.error) throw inserted.error;
}

export async function activateTelemetryWithdrawalJob(jobId: string): Promise<void> {
  const now = new Date().toISOString();
  const activated = await db
    .from(WITHDRAWAL_JOB_TABLE)
    .update({
      status: "pending",
      next_attempt_at: now,
      updated_at: now,
      last_error: null,
    })
    .eq("id", jobId)
    .eq("status", "awaiting_consent");
  if (activated.error) throw activated.error;
}

export async function cancelTelemetryWithdrawalJob(
  jobId: string,
  reason: string,
): Promise<void> {
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
      last_error: reason.slice(0, 500),
      updated_at: now,
    })
    .eq("id", jobId)
    .in("status", ["awaiting_consent", "pending", "retrying", "processing"]);
  if (cancelled.error) throw cancelled.error;
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
      throw new Error("withdrawal_consents_not_yet_committed");
    }
  }
}

async function updateRecordingsForSessions(
  actorUserId: string,
  sessionIds: string[],
  deletionDueAt: string,
  withdrawnAt: string,
  microphoneOnly: boolean,
): Promise<void> {
  for (const sessionId of sessionIds) {
    let query = db
      .from("test_recordings")
      .update({ deletion_due_at: deletionDueAt })
      .eq("tester_user_id", actorUserId)
      .eq("test_session_id", sessionId)
      .lte("created_at", withdrawnAt);
    if (microphoneOnly) {
      query = query.not("microphone_consent_id", "is", null);
    }
    const recordings = await query;
    if (recordings.error) throw recordings.error;
  }
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

  const consentHistory = await db
    .from("telemetry_consents")
    .update({ retained_until: consentRetainedUntil })
    .eq("actor_user_id", actorUserId)
    .eq("pilot_id", pilotId)
    .lte("occurred_at", withdrawnAt)
    .lt("retained_until", consentRetainedUntil);
  if (consentHistory.error) throw consentHistory.error;

  const sessions = await db
    .from("test_sessions")
    .select("id")
    .eq("actor_user_id", actorUserId)
    .eq("pilot_id", pilotId)
    .lte("started_at", withdrawnAt);
  if (sessions.error) throw sessions.error;
  const sessionIds = (sessions.data ?? [])
    .map((row: Record<string, unknown>) => row["id"])
    .filter((id: unknown): id is string => typeof id === "string");

  if (scopes.has("telemetry")) {
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
      .lte("started_at", withdrawnAt);
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
      .lte("occurred_at", withdrawnAt);
    if (eventUpdate.error) throw eventUpdate.error;

    const failureDelete = await db
      .from("activity_ingest_failures")
      .delete()
      .eq("actor_user_id", actorUserId)
      .eq("pilot_id", pilotId)
      .lte("created_at", withdrawnAt);
    if (failureDelete.error) throw failureDelete.error;

    const pilotRecordings = await db
      .from("test_recordings")
      .update({ deletion_due_at: deletionDueAt })
      .eq("tester_user_id", actorUserId)
      .eq("pilot_id", pilotId)
      .lte("created_at", withdrawnAt);
    if (pilotRecordings.error) throw pilotRecordings.error;
    await updateRecordingsForSessions(
      actorUserId,
      sessionIds,
      deletionDueAt,
      withdrawnAt,
      false,
    );

    const feedback = await db
      .from("test_feedback")
      .update({
        deletion_due_at: deletionDueAt,
        notification_status: "failed",
        notification_last_error: "telemetry_consent_withdrawn",
        notification_next_attempt_at: null,
        updated_at: withdrawnAt,
      })
      .eq("tester_user_id", actorUserId)
      .eq("pilot_id", pilotId)
      .lte("created_at", withdrawnAt);
    if (feedback.error) throw feedback.error;
    return;
  }

  const updates: Record<string, unknown> = { updated_at: withdrawnAt };
  if (scopes.has("screen")) {
    updates["screen_consent_state"] = "withdrawn";
    updates["recording_status"] = "withdrawn";
  }
  if (scopes.has("microphone")) {
    updates["microphone_consent_state"] = "withdrawn";
    updates["recording_status"] = "withdrawn";
  }
  const sessionUpdate = await db
    .from("test_sessions")
    .update(updates)
    .eq("actor_user_id", actorUserId)
    .eq("pilot_id", pilotId)
    .eq("status", "active")
    .lte("started_at", withdrawnAt);
  if (sessionUpdate.error) throw sessionUpdate.error;

  if (scopes.has("screen") || scopes.has("microphone")) {
    const microphoneOnly = !scopes.has("screen");
    let pilotRecordings = db
      .from("test_recordings")
      .update({ deletion_due_at: deletionDueAt })
      .eq("tester_user_id", actorUserId)
      .eq("pilot_id", pilotId)
      .lte("created_at", withdrawnAt);
    if (microphoneOnly) {
      pilotRecordings = pilotRecordings.not("microphone_consent_id", "is", null);
    }
    const recordings = await pilotRecordings;
    if (recordings.error) throw recordings.error;
    await updateRecordingsForSessions(
      actorUserId,
      sessionIds,
      deletionDueAt,
      withdrawnAt,
      microphoneOnly,
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
  if (loaded.data.status === "completed") return { status: "completed" };
  if (loaded.data.status === "cancelled") return { status: "skipped" };

  const claimed = await claimJob(loaded.data);
  if (!claimed) return { status: "pending" };

  try {
    await verifyCommittedWithdrawal(claimed);
    await applyTelemetryWithdrawalCleanup(claimed);
    await completeJob(claimed);
    return { status: "completed" };
  } catch (error) {
    try {
      await retryJob(claimed, error);
    } catch (retryError) {
      logger.error(
        { err: retryError, withdrawalJobId: jobId },
        "Could not release telemetry withdrawal cleanup lease",
      );
    }
    return { status: "pending", error: safeError(error) };
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
