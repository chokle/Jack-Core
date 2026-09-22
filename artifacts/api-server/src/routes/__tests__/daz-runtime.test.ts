import { vi, describe, it, expect, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

vi.hoisted(() => {
  process.env["ADMIN_EMAILS"] = "admin@torchlabs.ca";
});

const getAuth = vi.hoisted(() => vi.fn());
const getUser = vi.hoisted(() => vi.fn());
vi.mock("@clerk/express", () => ({
  getAuth,
  clerkClient: { users: { getUser } },
}));

const readDazRuntimeStatus = vi.hoisted(() => vi.fn());
const requestDazTask = vi.hoisted(() => vi.fn());
vi.mock("../../lib/daz-tasks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/daz-tasks.js")>()),
  requestDazTask,
}));
vi.mock("../../lib/daz-runtime.js", () => ({
  readDazRuntimeStatus,
}));

import dazRuntimeRouter from "../daz-runtime.js";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const noop = () => {};
    (req as unknown as { log: Record<string, () => void> }).log = {
      warn: noop,
      error: noop,
      info: noop,
      debug: noop,
    };
    next();
  });
  app.use("/api", dazRuntimeRouter);
  return app;
}

function signInAs(role: "admin" | "user"): void {
  getAuth.mockReturnValue({ userId: role === "admin" ? "u_admin" : "u_user" });
  const email = role === "admin" ? "admin@torchlabs.ca" : "regular@example.com";
  getUser.mockResolvedValue({
    firstName: role === "admin" ? "Derek" : "Regular",
    lastName: role === "admin" ? "Admin" : "User",
    primaryEmailAddress: { emailAddress: email },
    emailAddresses: [{ emailAddress: email }],
    publicMetadata: {},
    privateMetadata: {},
  });
}

const app = makeApp();

beforeEach(() => {
  getAuth.mockReset();
  getUser.mockReset();
  readDazRuntimeStatus.mockReset();
  requestDazTask.mockReset();
});

describe("Daz task routes", () => {
  const id = "17fe8057-e179-4483-8d1b-b676b5a490fd";
  const input = { task_id: id, kind: "jack_health_report" };
  it("rejects anonymous and non-admin creation and retrieval", async () => {
    expect(
      (await request(app).post("/api/daz-runtime/tasks").send(input)).status,
    ).toBe(401);
    expect(
      (await request(app).get(`/api/daz-runtime/tasks/${id}`)).status,
    ).toBe(401);
    signInAs("user");
    expect(
      (await request(app).post("/api/daz-runtime/tasks").send(input)).status,
    ).toBe(403);
    expect(
      (await request(app).get(`/api/daz-runtime/tasks/${id}`)).status,
    ).toBe(403);
    expect(requestDazTask).not.toHaveBeenCalled();
  });
  it("rejects requester spoofing, arbitrary tasks and invalid IDs", async () => {
    signInAs("admin");
    for (const body of [
      { ...input, requested_by: "other" },
      { ...input, kind: "delete" },
      { ...input, task_id: "bad" },
    ]) {
      expect(
        (await request(app).post("/api/daz-runtime/tasks").send(body)).status,
      ).toBe(400);
    }
    expect(requestDazTask).not.toHaveBeenCalled();
  });
  it("preserves the idempotency key and derives identity from Clerk for all attempts", async () => {
    signInAs("admin");
    requestDazTask.mockResolvedValue({ ok: true, task: { task_id: id } });
    await request(app).post("/api/daz-runtime/tasks").send(input);
    await request(app).post("/api/daz-runtime/tasks").send(input);
    expect(requestDazTask.mock.calls).toEqual([
      [id, "u_admin", true],
      [id, "u_admin", true],
    ]);
    const res = await request(app).get(
      `/api/daz-runtime/tasks/${id}?requested_by=spoof`,
    );
    expect(requestDazTask).toHaveBeenLastCalledWith(id, "u_admin", false);
    expect(res.headers["cache-control"]).toBe("no-store");
  });
  it("returns a safe unknown-outcome error without leaking runtime details", async () => {
    signInAs("admin");
    requestDazTask.mockRejectedValue(new Error("secret token"));
    const res = await request(app).post("/api/daz-runtime/tasks").send(input);
    expect(res.status).toBe(503);
    expect(res.text).not.toContain("secret token");
    expect(res.body.error).toContain("same task ID");
  });
});

describe("GET /daz-runtime/status", () => {
  it("rejects an anonymous caller with 401 and never calls the runtime", async () => {
    const res = await request(app).get("/api/daz-runtime/status");

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized — sign in required." });
    expect(readDazRuntimeStatus).not.toHaveBeenCalled();
  });

  it("rejects a signed-in non-admin with 403 and never calls the runtime", async () => {
    signInAs("user");

    const res = await request(app).get("/api/daz-runtime/status");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Forbidden — admin access required." });
    expect(readDazRuntimeStatus).not.toHaveBeenCalled();
  });

  it("allows an admin and returns the deployed runtime status envelope", async () => {
    signInAs("admin");
    const status = {
      health: {
        ok: true,
        schema_version: 1,
        adapter: "primary",
        durable_object: true,
      },
      state: {
        schema_version: 1,
        identity: { id: "daz", pronouns: "she/her" },
        adapter: "primary",
        generation: 7,
        active: false,
        receipts: 3,
        recoveries: 1,
        authority_audit_entries: 2,
      },
    };
    readDazRuntimeStatus.mockResolvedValue(status);

    const res = await request(app).get("/api/daz-runtime/status");

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toMatchObject({
      ok: true,
      reviewer: "Derek Admin",
      request: { path: "/api/daz-runtime/status", method: "GET" },
      status,
    });
    expect(typeof res.body.checked_at).toBe("string");
    expect(new Date(res.body.checked_at).toString()).not.toBe("Invalid Date");
    expect(readDazRuntimeStatus).toHaveBeenCalledTimes(1);
  });

  it("returns 503 when the runtime cannot be reached", async () => {
    signInAs("admin");
    readDazRuntimeStatus.mockRejectedValue(new Error("runtime unavailable"));

    const res = await request(app).get("/api/daz-runtime/status");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      ok: false,
      error: "Daz runtime status unavailable.",
    });
  });
});
