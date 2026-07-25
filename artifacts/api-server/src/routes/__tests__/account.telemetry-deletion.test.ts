import express, { type Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const deletedTables = vi.hoisted(() => [] as string[]);
const deleteUser = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@clerk/express", () => ({
  getAuth: () => ({ userId: "user-1" }),
  clerkClient: { users: { deleteUser } },
}));
vi.mock("../../lib/jobs.js", () => ({ removeGraphSafe: vi.fn() }));
vi.mock("../../lib/memory-graph.js", () => ({ withdrawMentor: vi.fn() }));
vi.mock("../../lib/video-storage.js", () => ({ removeVideoAssets: vi.fn(async () => {}) }));
vi.mock("../../lib/supabase.js", () => ({
  supabase: {
    from: (table: string) => {
      const query = {
        select: () => query,
        delete: () => {
          deletedTables.push(table);
          return query;
        },
        eq: () => query,
        in: () => query,
        then: (
          resolve: (value: { data: unknown[]; error: null }) => unknown,
        ) => Promise.resolve(resolve({ data: [], error: null })),
      };
      return query;
    },
    storage: { from: () => ({ remove: vi.fn(async () => ({ error: null })) }) },
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
  deleteUser.mockClear();
});

describe("account deletion telemetry coverage", () => {
  it("deletes all attributable pilot data before removing the identity", async () => {
    const response = await request(app()).delete("/api/account");
    expect(response.status).toBe(204);
    expect(new Set(deletedTables)).toEqual(
      new Set([
        "videos",
        "chat_messages",
        "test_recordings",
        "test_feedback",
        "activity_ingest_failures",
        "test_events",
        "activity_report_runs",
        "admin_access_audit",
        "test_sessions",
        "telemetry_consents",
        "pilot_memberships",
        "platform_roles",
      ]),
    );
    expect(deleteUser).toHaveBeenCalledWith("user-1");
  });
});
