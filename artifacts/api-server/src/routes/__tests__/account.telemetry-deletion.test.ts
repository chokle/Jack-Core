import express, { type Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const deletedTables = vi.hoisted(() => [] as string[]);
const rpcCalls = vi.hoisted(
  () => [] as Array<{ name: string; params: Record<string, unknown> }>,
);
const operationOrder = vi.hoisted(() => [] as string[]);
const deletions = vi.hoisted(
  () => [] as Array<{ table: string; column: string; value: unknown }>,
);
const updates = vi.hoisted(
  () => [] as Array<{ table: string; values: Record<string, unknown>; column: string; value: unknown }>,
);
const deleteUser = vi.hoisted(() => vi.fn(async () => {}));
const recordingRows = vi.hoisted(
  () => [] as Array<{ id: string; tester_user_id: string; storage_path: string }>,
);
const removeRecordingObjects = vi.hoisted(() =>
  vi.fn<(paths: string[]) => Promise<{ error: unknown }>>(async () => ({ error: null })),
);
const removeVideoGraph = vi.hoisted(() => vi.fn(async () => {}));
const removeContributorGraph = vi.hoisted(() => vi.fn(async () => {}));
const withdrawMentor = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@clerk/express", () => ({
  getAuth: () => ({ userId: "user-1" }),
  clerkClient: { users: { deleteUser } },
}));
vi.mock("../../lib/memory-graph.js", () => ({
  removeVideoGraph,
  removeContributorGraph,
  withdrawMentor,
}));
vi.mock("../../lib/video-storage.js", () => ({ removeVideoAssets: vi.fn(async () => {}) }));
vi.mock("../../lib/supabase.js", () => ({
  supabase: {
    rpc: async (name: string, params: Record<string, unknown>) => {
      rpcCalls.push({ name, params });
      operationOrder.push(`rpc:${name}`);
      return { data: null, error: null };
    },
    from: (table: string) => {
      operationOrder.push(`from:${table}`);
      let operation: "select" | "delete" = "select";
      let updateValues: Record<string, unknown> | null = null;
      let limit: number | undefined;
      let equals: { column: string; value: unknown } | undefined;
      let included: { column: string; values: unknown[] } | undefined;
      const query = {
        select: () => query,
        delete: () => {
          operation = "delete";
          deletedTables.push(table);
          return query;
        },
        update: (values: Record<string, unknown>) => {
          operation = "delete";
          updateValues = values;
          return query;
        },
        eq: (column: string, value: unknown) => {
          equals = { column, value };
          if (updateValues) {
            updates.push({ table, values: updateValues, column, value });
            return query;
          }
          if (operation === "delete") deletions.push({ table, column, value });
          return query;
        },
        in: (column: string, values: unknown[]) => {
          included = { column, values };
          return query;
        },
        limit: (value: number) => {
          limit = value;
          return query;
        },
        then: (
          resolve: (value: { data: unknown[]; error: null }) => unknown,
        ) => {
          if (table !== "test_recordings") {
            return Promise.resolve(resolve({ data: [], error: null }));
          }
          if (operation === "delete") {
            const ids = new Set(included?.column === "id" ? included.values : []);
            for (let index = recordingRows.length - 1; index >= 0; index -= 1) {
              if (ids.has(recordingRows[index]!.id)) recordingRows.splice(index, 1);
            }
            return Promise.resolve(resolve({ data: [], error: null }));
          }
          const rows = recordingRows.filter(
            (row) => !equals || row[equals.column as keyof typeof row] === equals.value,
          );
          return Promise.resolve(resolve({ data: rows.slice(0, limit), error: null }));
        },
      };
      return query;
    },
    storage: { from: () => ({ remove: removeRecordingObjects }) },
  },
}));

import accountRouter from "../account.js";

function app(): Express {
  const value = express();
  value.use((req, _res, next) => {
    (req as never as { log: { error: ReturnType<typeof vi.fn> } }).log = {
      error: vi.fn(),
    };
    next();
  });
  value.use("/api", accountRouter);
  return value;
}

beforeEach(() => {
  deletedTables.length = 0;
  rpcCalls.length = 0;
  operationOrder.length = 0;
  deletions.length = 0;
  updates.length = 0;
  recordingRows.length = 0;
  deleteUser.mockClear();
  removeRecordingObjects.mockReset();
  removeRecordingObjects.mockResolvedValue({ error: null });
  removeVideoGraph.mockReset();
  removeVideoGraph.mockResolvedValue(undefined);
  removeContributorGraph.mockReset();
  removeContributorGraph.mockResolvedValue(undefined);
  withdrawMentor.mockReset();
  withdrawMentor.mockResolvedValue(undefined);
});

describe("account deletion telemetry coverage", () => {
  it("deletes all attributable pilot data before removing the identity", async () => {
    recordingRows.push({
      id: "recording-one",
      tester_user_id: "user-1",
      storage_path: "recordings/one.webm",
    });
    const response = await request(app()).delete("/api/account");
    expect(response.status).toBe(204);
    expect(new Set(deletedTables)).toEqual(
      new Set([
        "videos",
        "interview_sessions",
        "parked_thoughts",
        "chat_messages",
        "test_recordings",
        "test_feedback",
        "end_of_shift_closeouts",
        "pilot_access_handoffs",
        "activity_ingest_failures",
        "test_events",
        "admin_access_audit",
        "test_sessions",
        "pilot_memberships",
        "platform_roles",
      ]),
    );
    expect(rpcCalls).toEqual([
      {
        name: "begin_telemetry_account_deletion",
        params: { p_actor_user_id: "user-1" },
      },
      {
        name: "finish_telemetry_account_deletion",
        params: { p_actor_user_id: "user-1" },
      },
    ]);
    expect(operationOrder[0]).toBe("rpc:begin_telemetry_account_deletion");
    expect(operationOrder.indexOf("rpc:finish_telemetry_account_deletion")).toBeGreaterThan(
      operationOrder.indexOf("from:test_sessions"),
    );
    expect(deletions.filter(({ table }) => table === "activity_report_runs")).toEqual([]);
    expect(
      updates.filter(({ table }) => table === "activity_report_runs"),
    ).toEqual([
      {
        table: "activity_report_runs",
        values: { requested_by_user_id: null },
        column: "requested_by_user_id",
        value: "user-1",
      },
    ]);
    expect(
      updates.filter(({ table }) => table === "pilot_memberships"),
    ).toEqual([
      {
        table: "pilot_memberships",
        values: { created_by_user_id: null },
        column: "created_by_user_id",
        value: "user-1",
      },
    ]);
    expect(
      updates.filter(({ table }) => table === "platform_roles"),
    ).toEqual([
      {
        table: "platform_roles",
        values: { created_by_user_id: null },
        column: "created_by_user_id",
        value: "user-1",
      },
    ]);
    expect(removeContributorGraph).toHaveBeenCalledWith("user-1");
    expect(deleteUser).toHaveBeenCalledWith("user-1");
  });

  it("keeps the identity when strict contributor graph cleanup fails", async () => {
    removeContributorGraph.mockRejectedValueOnce(new Error("graph unavailable"));

    const failed = await request(app()).delete("/api/account");

    expect(failed.status).toBe(500);
    expect(deleteUser).not.toHaveBeenCalled();
    expect(rpcCalls.map(({ name }) => name)).toEqual([
      "begin_telemetry_account_deletion",
    ]);

    const retried = await request(app()).delete("/api/account");
    expect(retried.status).toBe(204);
    expect(deleteUser).toHaveBeenCalledWith("user-1");
  });

  it("deletes every private recording object in bounded batches before the identity", async () => {
    recordingRows.push(
      ...Array.from({ length: 1_001 }, (_, index) => ({
        id: `recording-${index}`,
        tester_user_id: "user-1",
        storage_path: `recordings/${index}.webm`,
      })),
    );

    const response = await request(app()).delete("/api/account");

    expect(response.status).toBe(204);
    expect(recordingRows).toHaveLength(0);
    expect(removeRecordingObjects.mock.calls.map(([paths]) => paths.length)).toEqual([500, 500, 1]);
    expect(deleteUser).toHaveBeenCalledWith("user-1");
  });

  it("keeps the identity and recording rows when storage deletion fails, then retries safely", async () => {
    recordingRows.push({
      id: "recording-retry",
      tester_user_id: "user-1",
      storage_path: "recordings/retry.webm",
    });
    removeRecordingObjects.mockResolvedValueOnce({
      error: { name: "StorageError", message: "provider unavailable" },
    });

    const failed = await request(app()).delete("/api/account");
    expect(failed.status).toBe(500);
    expect(recordingRows).toHaveLength(1);
    expect(deleteUser).not.toHaveBeenCalled();
    expect(rpcCalls.map(({ name }) => name)).toEqual([
      "begin_telemetry_account_deletion",
    ]);

    const retried = await request(app()).delete("/api/account");
    expect(retried.status).toBe(204);
    expect(recordingRows).toHaveLength(0);
    expect(deleteUser).toHaveBeenCalledWith("user-1");
    expect(rpcCalls.map(({ name }) => name)).toEqual([
      "begin_telemetry_account_deletion",
      "begin_telemetry_account_deletion",
      "finish_telemetry_account_deletion",
    ]);
  });
});
