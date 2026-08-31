import crypto from "node:crypto";
import { supabase } from "./supabase.js";
import { logger } from "./logger.js";

export type StorageUploadKind =
  | "video_ingest"
  | "video_signed"
  | "test_recording"
  | "video_thumbnail";

export interface StorageUploadObligation {
  id: string;
  actorUserId: string;
  kind: StorageUploadKind;
  resourceId: string;
  bucket: "jack-videos" | "jack-test-recordings";
  objectPaths: string[];
  uploadLeaseToken: string;
  uploadLeaseExpiresAt: string;
}

interface ClaimedStorageUploadObligation {
  id: string;
  actor_user_id: string;
  kind: StorageUploadKind;
  resource_id: string;
  bucket: "jack-videos" | "jack-test-recordings";
  object_paths: string[];
  state: "cleaning";
  upload_lease_token: string;
  upload_lease_expires_at: string;
  upload_closed_at: string | null;
  absence_verified_at: string | null;
  cleanup_lease_token: string;
  cleanup_lease_expires_at: string;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
}

interface PrepareAccountCleanupRow {
  active_lease_count: number | string;
  pending_cleanup_count: number | string;
  retry_after_seconds: number | string | null;
}

export type AccountStorageCleanupResult =
  | { status: "ready" }
  | { status: "active"; retryAfterSeconds: number }
  | { status: "pending"; retryAfterSeconds: number }
  | {
      status: "failed";
      retryAfterSeconds: number;
      error: string;
    };

export interface StorageUploadReconcileResult {
  claimed: number;
  cleaned: number;
  delayedForLateArrival: number;
  failed: number;
  errors: string[];
}

const db = supabase as unknown as {
  rpc: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: unknown }>;
  storage: {
    from: (bucket: string) => {
      remove: (paths: string[]) => Promise<{ error: unknown }>;
      list: (
        prefix: string,
        options: { limit: number; search: string },
      ) => Promise<{
        data: Array<{ name?: string }> | null;
        error: unknown;
      }>;
    };
  };
};

export const VIDEO_INGEST_UPLOAD_LEASE_MS = 4 * 60 * 60 * 1000;
export const SIGNED_VIDEO_UPLOAD_LEASE_MS = 4 * 60 * 60 * 1000;
export const RECORDING_UPLOAD_LEASE_MS = 2 * 60 * 60 * 1000;
export const THUMBNAIL_UPLOAD_LEASE_MS = 15 * 60 * 1000;
export const STORAGE_CLEANUP_LEASE_MS = 2 * 60 * 1000;
export const LATE_UPLOAD_ARRIVAL_GRACE_MS = 15 * 60 * 1000;
const RECONCILE_INTERVAL_MS = 60_000;
const MAX_BEGIN_LEASE_MS = 4 * 60 * 60 * 1000;
const DEFAULT_RETRY_AFTER_SECONDS = 30;

export class StorageAccountDeletionFenceError extends Error {
  constructor(message = "Account deletion is already in progress.") {
    super(message);
    this.name = "StorageAccountDeletionFenceError";
  }
}

export class StorageUploadCasError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageUploadCasError";
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  return String(error);
}

export function isStorageAccountDeletionFenceError(error: unknown): boolean {
  if (error instanceof StorageAccountDeletionFenceError) return true;
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate.code === "P0001" &&
    typeof candidate.message === "string" &&
    candidate.message.toLowerCase().includes("account deletion")
  );
}

function throwRpcError(error: unknown): never {
  if (isStorageAccountDeletionFenceError(error)) {
    throw new StorageAccountDeletionFenceError(errorMessage(error));
  }
  if (error instanceof Error) throw error;
  throw new Error(errorMessage(error));
}

function safeRelativePath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\")) return false;
  return path
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function validateObjectPaths(input: {
  kind: StorageUploadKind;
  resourceId: string;
  bucket: "jack-videos" | "jack-test-recordings";
  objectPaths: string[];
}): void {
  const uniquePaths = new Set(input.objectPaths);
  if (
    input.objectPaths.length === 0 ||
    input.objectPaths.length > 8 ||
    uniquePaths.size !== input.objectPaths.length ||
    input.objectPaths.some((path) => !safeRelativePath(path))
  ) {
    throw new Error("Storage upload obligations require unique safe relative paths.");
  }

  const expectedBucket =
    input.kind === "test_recording" ? "jack-test-recordings" : "jack-videos";
  if (input.bucket !== expectedBucket) {
    throw new Error("Storage upload obligation bucket does not match its kind.");
  }

  const expectedPath =
    input.kind === "video_thumbnail"
      ? `thumbnails/${input.resourceId}.jpg`
      : input.kind === "test_recording"
        ? `recordings/${input.resourceId}/`
        : `videos/${input.resourceId}/`;
  const pathsMatch =
    input.kind === "video_thumbnail"
      ? input.objectPaths.length === 1 && input.objectPaths[0] === expectedPath
      : input.objectPaths.every((path) => path.startsWith(expectedPath));
  if (!pathsMatch) {
    throw new Error("Storage upload obligation path does not match its resource.");
  }
}

export async function beginStorageUploadObligation(input: {
  actorUserId: string;
  kind: StorageUploadKind;
  resourceId: string;
  bucket: "jack-videos" | "jack-test-recordings";
  objectPaths: string[];
  leaseMs: number;
  id?: string;
  uploadLeaseToken?: string;
  now?: Date;
}): Promise<StorageUploadObligation> {
  const actorUserId = input.actorUserId.trim();
  if (!actorUserId) throw new Error("Storage upload actor is required.");
  if (
    !Number.isFinite(input.leaseMs) ||
    input.leaseMs <= 0 ||
    input.leaseMs > MAX_BEGIN_LEASE_MS
  ) {
    throw new Error("Storage upload lease is outside the allowed window.");
  }
  validateObjectPaths(input);

  const now = input.now ?? new Date();
  const obligation: StorageUploadObligation = {
    id: input.id ?? crypto.randomUUID(),
    actorUserId,
    kind: input.kind,
    resourceId: input.resourceId,
    bucket: input.bucket,
    objectPaths: [...input.objectPaths],
    uploadLeaseToken: input.uploadLeaseToken ?? crypto.randomUUID(),
    uploadLeaseExpiresAt: new Date(now.getTime() + input.leaseMs).toISOString(),
  };

  const { error } = await db.rpc("begin_storage_upload_obligation", {
    p_id: obligation.id,
    p_actor_user_id: obligation.actorUserId,
    p_kind: obligation.kind,
    p_resource_id: obligation.resourceId,
    p_bucket: obligation.bucket,
    p_object_paths: obligation.objectPaths,
    p_upload_lease_token: obligation.uploadLeaseToken,
    p_upload_lease_expires_at: obligation.uploadLeaseExpiresAt,
  });
  if (error) throwRpcError(error);
  return obligation;
}

function rpcBoolean(data: unknown): boolean {
  if (typeof data === "boolean") return data;
  if (Array.isArray(data) && data.length === 1 && typeof data[0] === "boolean") {
    return data[0];
  }
  return false;
}

export async function finalizeStorageUploadObligation(
  obligation: StorageUploadObligation,
): Promise<void> {
  const { data, error } = await db.rpc("finalize_storage_upload_obligation", {
    p_id: obligation.id,
    p_actor_user_id: obligation.actorUserId,
    p_upload_lease_token: obligation.uploadLeaseToken,
  });
  if (error) throwRpcError(error);
  if (!rpcBoolean(data)) {
    throw new StorageUploadCasError("Storage upload obligation could not be finalized.");
  }
}

export async function requestStorageUploadCleanup(
  obligation: StorageUploadObligation,
  options: { uploadClosed: boolean; error?: unknown },
): Promise<void> {
  const { data, error } = await db.rpc("request_storage_upload_cleanup", {
    p_id: obligation.id,
    p_actor_user_id: obligation.actorUserId,
    p_upload_lease_token: obligation.uploadLeaseToken,
    p_upload_closed: options.uploadClosed,
    p_last_error:
      options.error === undefined ? null : errorMessage(options.error).slice(0, 2_000),
  });
  if (error) throwRpcError(error);
  if (!rpcBoolean(data)) {
    throw new StorageUploadCasError("Storage upload cleanup could not be scheduled.");
  }
}

function claimedRows(data: unknown): ClaimedStorageUploadObligation[] {
  if (!Array.isArray(data)) return [];
  return data.filter(
    (row): row is ClaimedStorageUploadObligation =>
      Boolean(
        row &&
          typeof row === "object" &&
          typeof (row as ClaimedStorageUploadObligation).id === "string" &&
          typeof (row as ClaimedStorageUploadObligation).actor_user_id === "string" &&
          typeof (row as ClaimedStorageUploadObligation).bucket === "string" &&
          Array.isArray((row as ClaimedStorageUploadObligation).object_paths),
      ),
  );
}

function splitStoragePath(path: string): { prefix: string; name: string } {
  const index = path.lastIndexOf("/");
  return index < 0
    ? { prefix: "", name: path }
    : { prefix: path.slice(0, index), name: path.slice(index + 1) };
}

async function verifyObjectAbsent(
  bucket: "jack-videos" | "jack-test-recordings",
  path: string,
): Promise<void> {
  const { prefix, name } = splitStoragePath(path);
  const { data, error } = await db.storage
    .from(bucket)
    .list(prefix, { limit: 100, search: name });
  if (error) throw error;
  if ((data ?? []).some((object) => object.name === name)) {
    throw new Error(`Storage object still exists after removal: ${bucket}/${path}`);
  }
}

function retryDelayMs(attempts: number): number {
  return Math.min(15 * 60 * 1000, 30_000 * 2 ** Math.max(0, attempts - 1));
}

async function retryClaim(
  row: ClaimedStorageUploadObligation,
  cleanupToken: string,
  options: {
    error: unknown;
    now: Date;
    absenceVerified: boolean;
    delayMs?: number;
  },
): Promise<void> {
  const nextAttemptAt = new Date(
    options.now.getTime() +
      (options.delayMs ?? retryDelayMs(Number(row.attempts) || 1)),
  ).toISOString();
  const { data, error } = await db.rpc("retry_storage_upload_cleanup", {
    p_id: row.id,
    p_cleanup_lease_token: cleanupToken,
    p_last_error: errorMessage(options.error).slice(0, 2_000),
    p_next_attempt_at: nextAttemptAt,
    p_absence_verified: options.absenceVerified,
  });
  if (error) throwRpcError(error);
  if (!rpcBoolean(data)) {
    throw new StorageUploadCasError("Storage upload cleanup retry lost its lease.");
  }
}

async function cleanupClaimedRow(
  row: ClaimedStorageUploadObligation,
  cleanupToken: string,
  now: Date,
): Promise<"cleaned" | "delayed"> {
  validateObjectPaths({
    kind: row.kind,
    resourceId: row.resource_id,
    bucket: row.bucket,
    objectPaths: row.object_paths,
  });

  const removed = await db.storage.from(row.bucket).remove(row.object_paths);
  if (removed.error) throw removed.error;
  for (const path of row.object_paths) {
    await verifyObjectAbsent(row.bucket, path);
  }

  if (!row.upload_closed_at && !row.absence_verified_at) {
    await retryClaim(row, cleanupToken, {
      error: "post_lease_absence_verification",
      now,
      absenceVerified: true,
      delayMs: LATE_UPLOAD_ARRIVAL_GRACE_MS,
    });
    return "delayed";
  }

  const { data, error } = await db.rpc("complete_storage_upload_cleanup", {
    p_id: row.id,
    p_cleanup_lease_token: cleanupToken,
  });
  if (error) throwRpcError(error);
  if (!rpcBoolean(data)) {
    throw new StorageUploadCasError("Storage upload cleanup completion lost its lease.");
  }
  return "cleaned";
}

export async function reconcileStorageUploadObligations(options: {
  actorUserId?: string;
  limit?: number;
  now?: Date;
  cleanupToken?: string;
} = {}): Promise<StorageUploadReconcileResult> {
  const now = options.now ?? new Date();
  const limit = Math.max(1, Math.min(100, options.limit ?? 25));
  const cleanupToken = options.cleanupToken ?? crypto.randomUUID();
  const { data, error } = await db.rpc("claim_storage_upload_cleanup", {
    p_cleanup_lease_token: cleanupToken,
    p_cleanup_lease_expires_at: new Date(
      now.getTime() + STORAGE_CLEANUP_LEASE_MS,
    ).toISOString(),
    p_actor_user_id: options.actorUserId ?? null,
    p_limit: limit,
  });
  if (error) throwRpcError(error);

  const rows = claimedRows(data);
  const result: StorageUploadReconcileResult = {
    claimed: rows.length,
    cleaned: 0,
    delayedForLateArrival: 0,
    failed: 0,
    errors: [],
  };
  for (const row of rows) {
    try {
      const outcome = await cleanupClaimedRow(row, cleanupToken, now);
      if (outcome === "cleaned") result.cleaned += 1;
      else result.delayedForLateArrival += 1;
    } catch (cleanupError) {
      result.failed += 1;
      result.errors.push(errorMessage(cleanupError));
      try {
        await retryClaim(row, cleanupToken, {
          error: cleanupError,
          now,
          absenceVerified: false,
        });
      } catch (retryError) {
        result.errors.push(errorMessage(retryError));
        logger.error(
          { err: retryError, obligationId: row.id },
          "failed to reschedule storage upload cleanup",
        );
      }
    }
  }
  return result;
}

function prepareRow(data: unknown): PrepareAccountCleanupRow {
  const candidate = Array.isArray(data) ? data[0] : data;
  if (!candidate || typeof candidate !== "object") {
    throw new Error("Account storage cleanup preparation returned no status.");
  }
  return candidate as PrepareAccountCleanupRow;
}

function count(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function retryAfter(value: number | string | null | undefined): number {
  const parsed = Number(value ?? DEFAULT_RETRY_AFTER_SECONDS);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.max(1, Math.ceil(parsed))
    : DEFAULT_RETRY_AFTER_SECONDS;
}

async function prepareAccountRow(
  actorUserId: string,
): Promise<PrepareAccountCleanupRow> {
  const { data, error } = await db.rpc(
    "prepare_storage_account_upload_cleanup",
    { p_actor_user_id: actorUserId },
  );
  if (error) throwRpcError(error);
  return prepareRow(data);
}

export async function prepareAccountStorageCleanup(
  actorUserId: string,
): Promise<AccountStorageCleanupResult> {
  const actor = actorUserId.trim();
  if (!actor) throw new Error("Account storage cleanup actor is required.");

  let status = await prepareAccountRow(actor);
  if (count(status.active_lease_count) > 0) {
    return {
      status: "active",
      retryAfterSeconds: retryAfter(status.retry_after_seconds),
    };
  }

  const sweep = await reconcileStorageUploadObligations({
    actorUserId: actor,
    limit: 100,
  });
  status = await prepareAccountRow(actor);
  if (count(status.active_lease_count) > 0) {
    return {
      status: "active",
      retryAfterSeconds: retryAfter(status.retry_after_seconds),
    };
  }
  if (count(status.pending_cleanup_count) === 0) return { status: "ready" };
  if (sweep.failed > 0) {
    return {
      status: "failed",
      retryAfterSeconds: retryAfter(status.retry_after_seconds),
      error: sweep.errors[0] ?? "Storage cleanup failed.",
    };
  }
  return {
    status: "pending",
    retryAfterSeconds: retryAfter(status.retry_after_seconds),
  };
}

export async function purgeVerifiedAccountStorageObligations(
  actorUserId: string,
): Promise<void> {
  const actor = actorUserId.trim();
  if (!actor) throw new Error("Account storage cleanup actor is required.");
  const { error } = await db.rpc(
    "purge_verified_storage_account_obligations",
    { p_actor_user_id: actor },
  );
  if (error) throwRpcError(error);
}

export function startStorageUploadReconciler(): { stop: () => void } {
  if (process.env["STORAGE_UPLOAD_RECONCILER_ENABLED"] !== "true") {
    logger.info("storage upload reconciler disabled");
    return { stop: () => {} };
  }
  const sweep = () => {
    void reconcileStorageUploadObligations()
      .then((result) =>
        logger.info({ result }, "storage upload reconciliation completed"),
      )
      .catch((error) =>
        logger.error({ err: error }, "storage upload reconciliation failed"),
      );
  };
  sweep();
  const timer = setInterval(sweep, RECONCILE_INTERVAL_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
