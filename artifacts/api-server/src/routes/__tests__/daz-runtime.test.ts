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
