import { beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

const getUser = vi.hoisted(() => vi.fn());
const updateUserMetadata = vi.hoisted(() => vi.fn());
const resolveIdentity = vi.hoisted(() => vi.fn());
const hasAnyReportScope = vi.hoisted(() => vi.fn());

vi.mock("@clerk/express", () => ({
  getAuth: vi.fn(),
  clerkClient: { users: { getUser, updateUserMetadata } },
}));

vi.mock("../../lib/admin-auth.js", () => ({
  resolveIdentity,
}));

vi.mock("../../lib/activity-telemetry.js", () => ({
  hasAnyReportScope,
}));

import meRouter from "../me.js";

const logInfo = vi.fn();
const logError = vi.fn();

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.header("x-test-user") !== "none") req.userId = "user_123";
    (
      req as unknown as { log: Record<string, (...args: unknown[]) => void> }
    ).log = {
      info: logInfo,
      error: logError,
      warn: vi.fn(),
      debug: vi.fn(),
    };
    next();
  });
  app.use("/api", meRouter);
  return app;
}

const app = makeApp();
const preferenceUrl = "/api/me/preferences/memory-graph-onboarding";
const analyticsUrl = "/api/me/analytics/memory-graph-onboarding";

beforeEach(() => {
  getUser.mockReset();
  updateUserMetadata.mockReset();
  resolveIdentity.mockReset();
  hasAnyReportScope.mockReset();
  logInfo.mockReset();
  logError.mockReset();
  resolveIdentity.mockResolvedValue({
    userId: "user_123",
    email: "user@example.com",
    name: "User",
    isAdmin: false,
    isPresentation: false,
    classification: "resolved",
  });
  hasAnyReportScope.mockResolvedValue(false);
});

describe("/me pilot-report capability", () => {
  it("fails closed when trusted identity resolution is unavailable", async () => {
    resolveIdentity.mockResolvedValueOnce({
      userId: "user_123",
      email: null,
      name: null,
      isAdmin: false,
      isPresentation: false,
      classification: "unavailable",
    });
    hasAnyReportScope.mockResolvedValueOnce(true);

    const res = await request(app).get("/api/me");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      userId: "user_123",
      canViewPilotReports: false,
    });
  });
});

describe("Memory Graph onboarding preference", () => {
  it("returns only the sanitized onboarding preference", async () => {
    getUser.mockResolvedValue({
      privateMetadata: {
        memoryGraphOnboarding: { version: 1, status: "completed" },
        legalCaseNotes: "must never leave Clerk",
      },
    });

    const res = await request(app).get(preferenceUrl);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      preference: { version: 1, status: "completed" },
    });
    expect(JSON.stringify(res.body)).not.toContain("legalCaseNotes");
  });

  it("treats malformed or extended stored metadata as unseen", async () => {
    getUser.mockResolvedValue({
      privateMetadata: {
        memoryGraphOnboarding: { version: 1, status: "completed", extra: true },
      },
    });

    const res = await request(app).get(preferenceUrl);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ preference: null });
  });

  it("fails open at the API boundary when Clerk cannot read preferences", async () => {
    getUser.mockRejectedValue(new Error("Clerk unavailable"));

    const res = await request(app).get(preferenceUrl);

    expect(res.status).toBe(503);
    expect(logError).toHaveBeenCalledOnce();
  });

  it("persists only version and completed/skipped status", async () => {
    updateUserMetadata.mockResolvedValue({});

    const res = await request(app)
      .put(preferenceUrl)
      .send({ version: 1, status: "skipped" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ preference: { version: 1, status: "skipped" } });
    expect(updateUserMetadata).toHaveBeenCalledWith("user_123", {
      privateMetadata: {
        memoryGraphOnboarding: { version: 1, status: "skipped" },
      },
    });
  });

  it.each([
    { version: 2, status: "completed" },
    { version: 1, status: "seen" },
    { version: 1, status: "completed", userId: "spoofed" },
    { status: "completed" },
    null,
  ])("rejects an invalid or extended preference payload: %j", async (body) => {
    const res = await request(app)
      .put(preferenceUrl)
      .set("Content-Type", "application/json")
      .send(body === null ? "null" : body);

    expect(res.status).toBe(400);
    expect(updateUserMetadata).not.toHaveBeenCalled();
  });

  it("does not block the graph contract when preference persistence fails", async () => {
    updateUserMetadata.mockRejectedValue(new Error("Clerk unavailable"));

    const res = await request(app)
      .put(preferenceUrl)
      .send({ version: 1, status: "completed" });

    expect(res.status).toBe(503);
    expect(logError).toHaveBeenCalledOnce();
  });

  it("rejects unauthenticated preference reads and writes", async () => {
    const read = await request(app)
      .get(preferenceUrl)
      .set("x-test-user", "none");
    const write = await request(app)
      .put(preferenceUrl)
      .set("x-test-user", "none")
      .send({ version: 1, status: "completed" });

    expect(read.status).toBe(401);
    expect(write.status).toBe(401);
    expect(getUser).not.toHaveBeenCalled();
    expect(updateUserMetadata).not.toHaveBeenCalled();
  });
});

describe("Memory Graph onboarding analytics", () => {
  const allowed = [
    { event: "memory_onboarding_started", source: "automatic", version: 1 },
    {
      event: "memory_onboarding_step_viewed",
      source: "automatic",
      version: 1,
      step: 2,
    },
    {
      event: "memory_onboarding_skipped",
      source: "automatic",
      version: 1,
      step: 2,
    },
    {
      event: "memory_onboarding_completed",
      source: "replay",
      version: 1,
      step: 3,
    },
    { event: "memory_onboarding_reopened", source: "replay", version: 1 },
  ];

  it.each(allowed)("accepts allowlisted legacy event $event without logging it", async (body) => {
    const res = await request(app).post(analyticsUrl).send(body);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: true });
    expect(logInfo).not.toHaveBeenCalled();
  });

  it.each([
    { event: "unknown", source: "automatic", version: 1 },
    {
      event: "memory_onboarding_started",
      source: "automatic",
      version: 1,
      email: "x@y.ca",
    },
    { event: "memory_onboarding_step_viewed", source: "automatic", version: 1 },
    {
      event: "memory_onboarding_reopened",
      source: "replay",
      version: 1,
      step: 1,
    },
    {
      event: "memory_onboarding_skipped",
      source: "automatic",
      version: 1,
      step: 4,
    },
    {
      event: "memory_onboarding_completed",
      source: "other",
      version: 1,
      step: 3,
    },
  ])("rejects non-allowlisted analytics payload: %j", async (body) => {
    const res = await request(app).post(analyticsUrl).send(body);

    expect(res.status).toBe(400);
    expect(logInfo).not.toHaveBeenCalled();
  });

  it("returns accepted as a compatibility no-op", async () => {
    const res = await request(app).post(analyticsUrl).send({
      event: "memory_onboarding_started",
      source: "automatic",
      version: 1,
    });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: true });
  });

  it("rejects unauthenticated analytics", async () => {
    const res = await request(app)
      .post(analyticsUrl)
      .set("x-test-user", "none")
      .send({
        event: "memory_onboarding_started",
        source: "automatic",
        version: 1,
      });

    expect(res.status).toBe(401);
    expect(logInfo).not.toHaveBeenCalled();
  });
});
