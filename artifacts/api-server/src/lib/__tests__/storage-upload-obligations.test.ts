import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
const storageFrom = vi.fn();
const remove = vi.fn();
const list = vi.fn();
const logInfo = vi.fn();
const logError = vi.fn();

vi.mock("../supabase.js", () => ({
  supabase: {
    rpc,
    storage: { from: storageFrom },
  },
}));

vi.mock("../logger.js", () => ({
  logger: {
    info: logInfo,
    error: logError,
  },
}));

import {
  LATE_UPLOAD_ARRIVAL_GRACE_MS,
  StorageAccountDeletionFenceError,
  beginStorageUploadObligation,
  finalizeStorageUploadObligation,
  prepareAccountStorageCleanup,
  purgeVerifiedAccountStorageObligations,
  reconcileStorageUploadObligations,
  requestStorageUploadCleanup,
  startStorageUploadReconciler,
  type StorageUploadObligation,
} from "../storage-upload-obligations.js";

const NOW = new Date("2026-08-31T12:00:00.000Z");
const OBLIGATION_ID = "11111111-1111-4111-8111-111111111111";
const RESOURCE_ID = "22222222-2222-4222-8222-222222222222";
const UPLOAD_TOKEN = "33333333-3333-4333-8333-333333333333";
const CLEANUP_TOKEN = "44444444-4444-4444-8444-444444444444";
const STORAGE_PATH = `videos/${RESOURCE_ID}/pilot.mp4`;

function obligation(): StorageUploadObligation {
  return {
    id: OBLIGATION_ID,
    actorUserId: "user_1",
    kind: "video_ingest",
    resourceId: RESOURCE_ID,
    bucket: "jack-videos",
    objectPaths: [STORAGE_PATH],
    uploadLeaseToken: UPLOAD_TOKEN,
    uploadLeaseExpiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
  };
}

function claimed(overrides: Record<string, unknown> = {}) {
  return {
    id: OBLIGATION_ID,
    actor_user_id: "user_1",
    kind: "video_ingest",
    resource_id: RESOURCE_ID,
    bucket: "jack-videos",
    object_paths: [STORAGE_PATH],
    state: "cleaning",
    upload_lease_token: UPLOAD_TOKEN,
    upload_lease_expires_at: new Date(NOW.getTime() - 1).toISOString(),
    upload_closed_at: NOW.toISOString(),
    absence_verified_at: null,
    cleanup_lease_token: CLEANUP_TOKEN,
    cleanup_lease_expires_at: new Date(NOW.getTime() + 60_000).toISOString(),
    attempts: 1,
    next_attempt_at: NOW.toISOString(),
    last_error: null,
    ...overrides,
  };
}

beforeEach(() => {
  rpc.mockReset();
  storageFrom.mockReset();
  remove.mockReset();
  list.mockReset();
  logInfo.mockReset();
  logError.mockReset();
  storageFrom.mockReturnValue({ remove, list });
  remove.mockResolvedValue({ error: null });
  list.mockResolvedValue({ data: [], error: null });
  delete process.env["STORAGE_UPLOAD_RECONCILER_ENABLED"];
});

describe("storage upload obligation lifecycle", () => {
  it("commits an exact actor/path upload lease before returning to the caller", async () => {
    rpc.mockResolvedValue({ data: {}, error: null });

    const result = await beginStorageUploadObligation({
      actorUserId: "user_1",
      kind: "video_ingest",
      resourceId: RESOURCE_ID,
      bucket: "jack-videos",
      objectPaths: [STORAGE_PATH],
      leaseMs: 60_000,
      id: OBLIGATION_ID,
      uploadLeaseToken: UPLOAD_TOKEN,
      now: NOW,
    });

    expect(result).toEqual(obligation());
    expect(rpc).toHaveBeenCalledExactlyOnceWith(
      "begin_storage_upload_obligation",
      {
        p_id: OBLIGATION_ID,
        p_actor_user_id: "user_1",
        p_kind: "video_ingest",
        p_resource_id: RESOURCE_ID,
        p_bucket: "jack-videos",
        p_object_paths: [STORAGE_PATH],
        p_upload_lease_token: UPLOAD_TOKEN,
        p_upload_lease_expires_at: new Date(
          NOW.getTime() + 60_000,
        ).toISOString(),
      },
    );
  });

  it("rejects mismatched buckets and traversal paths before any durable write", async () => {
    await expect(
      beginStorageUploadObligation({
        actorUserId: "user_1",
        kind: "test_recording",
        resourceId: RESOURCE_ID,
        bucket: "jack-videos",
        objectPaths: [`recordings/${RESOURCE_ID}/capture.webm`],
        leaseMs: 60_000,
      }),
    ).rejects.toThrow(/bucket/i);
    await expect(
      beginStorageUploadObligation({
        actorUserId: "user_1",
        kind: "video_ingest",
        resourceId: RESOURCE_ID,
        bucket: "jack-videos",
        objectPaths: [`videos/${RESOURCE_ID}/../other.mp4`],
        leaseMs: 60_000,
      }),
    ).rejects.toThrow(/safe relative paths/i);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("maps the permanent account fence and refuses finalization", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: {
        code: "P0001",
        message: "account deletion is already in progress",
      },
    });

    await expect(finalizeStorageUploadObligation(obligation())).rejects.toBeInstanceOf(
      StorageAccountDeletionFenceError,
    );
  });

  it("schedules known-closed cleanup using the upload lease CAS", async () => {
    rpc.mockResolvedValue({ data: true, error: null });

    await requestStorageUploadCleanup(obligation(), {
      uploadClosed: true,
      error: new Error("finalization fenced"),
    });

    expect(rpc).toHaveBeenCalledExactlyOnceWith(
      "request_storage_upload_cleanup",
      expect.objectContaining({
        p_id: OBLIGATION_ID,
        p_actor_user_id: "user_1",
        p_upload_lease_token: UPLOAD_TOKEN,
        p_upload_closed: true,
        p_last_error: "finalization fenced",
      }),
    );
  });
});

describe("storage cleanup reconciliation", () => {
  it("removes exact paths, verifies absence, then complete-deletes known-closed metadata", async () => {
    rpc.mockImplementation(async (name: string) => {
      if (name === "claim_storage_upload_cleanup") {
        return { data: [claimed()], error: null };
      }
      if (name === "complete_storage_upload_cleanup") {
        return { data: true, error: null };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });

    const result = await reconcileStorageUploadObligations({
      now: NOW,
      cleanupToken: CLEANUP_TOKEN,
    });

    expect(result).toEqual({
      claimed: 1,
      cleaned: 1,
      delayedForLateArrival: 0,
      failed: 0,
      errors: [],
    });
    expect(storageFrom).toHaveBeenCalledWith("jack-videos");
    expect(remove).toHaveBeenCalledExactlyOnceWith([STORAGE_PATH]);
    expect(list).toHaveBeenCalledExactlyOnceWith(
      `videos/${RESOURCE_ID}`,
      { limit: 100, search: "pilot.mp4" },
    );
    expect(rpc).toHaveBeenCalledWith(
      "complete_storage_upload_cleanup",
      {
        p_id: OBLIGATION_ID,
        p_cleanup_lease_token: CLEANUP_TOKEN,
      },
    );
  });

  it("keeps an unknown-close crash obligation through grace and removes a late object on retry", async () => {
    const objects = new Set<string>();
    remove.mockImplementation(async (paths: string[]) => {
      for (const path of paths) objects.delete(path);
      return { error: null };
    });
    list.mockImplementation(async (prefix: string, options: { search: string }) => {
      const fullPath = prefix ? `${prefix}/${options.search}` : options.search;
      return {
        data: objects.has(fullPath) ? [{ name: options.search }] : [],
        error: null,
      };
    });
    let claimNumber = 0;
    rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === "claim_storage_upload_cleanup") {
        claimNumber += 1;
        return {
          data: [
            claimed({
              upload_closed_at: null,
              absence_verified_at:
                claimNumber === 1 ? null : NOW.toISOString(),
              attempts: claimNumber,
              cleanup_lease_token: args["p_cleanup_lease_token"],
            }),
          ],
          error: null,
        };
      }
      if (
        name === "retry_storage_upload_cleanup" ||
        name === "complete_storage_upload_cleanup"
      ) {
        return { data: true, error: null };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });

    const first = await reconcileStorageUploadObligations({
      now: NOW,
      cleanupToken: CLEANUP_TOKEN,
    });

    expect(first.delayedForLateArrival).toBe(1);
    expect(first.cleaned).toBe(0);
    expect(rpc).toHaveBeenCalledWith(
      "retry_storage_upload_cleanup",
      expect.objectContaining({
        p_absence_verified: true,
        p_next_attempt_at: new Date(
          NOW.getTime() + LATE_UPLOAD_ARRIVAL_GRACE_MS,
        ).toISOString(),
      }),
    );
    expect(
      rpc.mock.calls.some(([name]) => name === "complete_storage_upload_cleanup"),
    ).toBe(false);

    // The old upload lands after the first remove/absence check but before the
    // durable second-pass grace expires.
    objects.add(STORAGE_PATH);
    const second = await reconcileStorageUploadObligations({
      now: new Date(NOW.getTime() + LATE_UPLOAD_ARRIVAL_GRACE_MS),
      cleanupToken: CLEANUP_TOKEN,
    });

    expect(second.cleaned).toBe(1);
    expect(objects.has(STORAGE_PATH)).toBe(false);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledWith(
      "complete_storage_upload_cleanup",
      {
        p_id: OBLIGATION_ID,
        p_cleanup_lease_token: CLEANUP_TOKEN,
      },
    );
  });

  it("retains and reschedules metadata when storage removal fails", async () => {
    remove.mockResolvedValue({ error: { message: "storage unavailable" } });
    rpc.mockImplementation(async (name: string) => {
      if (name === "claim_storage_upload_cleanup") {
        return { data: [claimed()], error: null };
      }
      if (name === "retry_storage_upload_cleanup") {
        return { data: true, error: null };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });

    const result = await reconcileStorageUploadObligations({
      now: NOW,
      cleanupToken: CLEANUP_TOKEN,
    });

    expect(result.failed).toBe(1);
    expect(result.cleaned).toBe(0);
    expect(list).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith(
      "retry_storage_upload_cleanup",
      expect.objectContaining({
        p_id: OBLIGATION_ID,
        p_cleanup_lease_token: CLEANUP_TOKEN,
        p_absence_verified: false,
      }),
    );
    expect(
      rpc.mock.calls.some(([name]) => name === "complete_storage_upload_cleanup"),
    ).toBe(false);
  });
});

describe("whole-account storage cleanup", () => {
  it("returns a retryable active result without touching a live upload lease", async () => {
    rpc.mockImplementation(async (name: string) => {
      if (name === "prepare_storage_account_upload_cleanup") {
        return {
          data: [
            {
              active_lease_count: 1,
              pending_cleanup_count: 0,
              retry_after_seconds: 91,
            },
          ],
          error: null,
        };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });

    await expect(prepareAccountStorageCleanup("user_1")).resolves.toEqual({
      status: "active",
      retryAfterSeconds: 91,
    });
    expect(
      rpc.mock.calls.some(([name]) => name === "claim_storage_upload_cleanup"),
    ).toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });

  it("returns ready only after due object cleanup is verified and metadata is gone", async () => {
    let prepareCalls = 0;
    rpc.mockImplementation(async (name: string) => {
      if (name === "prepare_storage_account_upload_cleanup") {
        prepareCalls += 1;
        return {
          data: [
            {
              active_lease_count: 0,
              pending_cleanup_count: prepareCalls === 1 ? 1 : 0,
              retry_after_seconds: 1,
            },
          ],
          error: null,
        };
      }
      if (name === "claim_storage_upload_cleanup") {
        return { data: [claimed()], error: null };
      }
      if (name === "complete_storage_upload_cleanup") {
        return { data: true, error: null };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });

    await expect(prepareAccountStorageCleanup("user_1")).resolves.toEqual({
      status: "ready",
    });
    expect(remove).toHaveBeenCalledExactlyOnceWith([STORAGE_PATH]);
    expect(list).toHaveBeenCalledOnce();
  });

  it("asserts that no raw actor/path obligation remains before Clerk deletion", async () => {
    rpc.mockResolvedValue({ data: null, error: null });

    await purgeVerifiedAccountStorageObligations("user_1");

    expect(rpc).toHaveBeenCalledExactlyOnceWith(
      "purge_verified_storage_account_obligations",
      { p_actor_user_id: "user_1" },
    );
  });

  it("keeps the background reconciler disabled until deployment config enables it", () => {
    const worker = startStorageUploadReconciler();
    worker.stop();

    expect(logInfo).toHaveBeenCalledWith("storage upload reconciler disabled");
    expect(rpc).not.toHaveBeenCalled();
  });
});
