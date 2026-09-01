import { beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

const getAuth = vi.hoisted(() => vi.fn());
const resolveActiveTesterScope = vi.hoisted(() => vi.fn());
const resolveIdentity = vi.hoisted(() => vi.fn());

vi.mock("@clerk/express", () => ({ getAuth }));
vi.mock("../../lib/activity-telemetry.js", () => ({ resolveActiveTesterScope }));
vi.mock("../../lib/admin-auth.js", () => ({ resolveIdentity }));

import { requireAuth } from "../requireAuth.js";
import { requirePilotAccess } from "../requirePilotAccess.js";

function makeApp(): Express {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as {
      log: { warn: () => void; error: () => void };
    }).log = { warn: () => {}, error: () => {} };
    next();
  });
  app.use("/api", requireAuth);
  app.use("/api", requirePilotAccess);
  app.all(/.*/, (req, res) => {
    res.status(200).json({ ok: true, userId: req.userId ?? null });
  });
  return app;
}

const app = makeApp();

beforeEach(() => {
  getAuth.mockReset();
  resolveActiveTesterScope.mockReset();
  resolveIdentity.mockReset();
  delete process.env["PILOT_AUTH_BYPASS"];
});

describe("requirePilotAccess", () => {
  it.each(["/api/", "/api/healthz", "/api/system-health"])(
    "keeps public probe %s available without membership lookup",
    async (path) => {
      const res = await request(app).get(path);

      expect(res.status).toBe(200);
      expect(resolveActiveTesterScope).not.toHaveBeenCalled();
      expect(resolveIdentity).not.toHaveBeenCalled();
    },
  );

  it("allows a signed-in user with a current active tester membership", async () => {
    getAuth.mockReturnValue({ userId: "user_pilot" });
    resolveActiveTesterScope.mockResolvedValue({
      scope: {
        organizationId: "40817dd6-d2b8-4087-a6f2-f416500ab4e6",
        pilotId: "394314ad-782b-4683-bc5d-65a0a3ba2552",
        authority: "tester",
      },
    });

    const res = await request(app).get("/api/videos");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, userId: "user_pilot" });
    expect(resolveIdentity).not.toHaveBeenCalled();
  });

  it("allows a trusted admin even without a tester membership", async () => {
    getAuth.mockReturnValue({ userId: "user_admin" });
    resolveActiveTesterScope.mockResolvedValue({ scope: null, reason: "not_enrolled" });
    resolveIdentity.mockResolvedValue({
      userId: "user_admin",
      email: "admin@torchlabs.ca",
      name: "Admin",
      isAdmin: true,
      isPresentation: false,
      classification: "resolved",
    });

    const res = await request(app).post("/api/videos/ingest").send({});

    expect(res.status).toBe(200);
  });

  it("rejects a signed-in Clerk user without active pilot membership", async () => {
    getAuth.mockReturnValue({ userId: "user_unapproved" });
    resolveActiveTesterScope.mockResolvedValue({ scope: null, reason: "not_enrolled" });
    resolveIdentity.mockResolvedValue({
      userId: "user_unapproved",
      email: "visitor@example.com",
      name: "Visitor",
      isAdmin: false,
      isPresentation: false,
      classification: "resolved",
    });

    const res = await request(app).get("/api/videos");

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: expect.stringContaining("active Torch pilot membership"),
    });
  });

  it("fails closed when a caller has ambiguous active pilot membership", async () => {
    getAuth.mockReturnValue({ userId: "user_ambiguous" });
    resolveActiveTesterScope.mockResolvedValue({
      scope: null,
      reason: "ambiguous_pilot",
    });
    resolveIdentity.mockResolvedValue({
      userId: "user_ambiguous",
      email: null,
      name: null,
      isAdmin: false,
      isPresentation: false,
      classification: "resolved",
    });

    const res = await request(app).get("/api/chat");

    expect(res.status).toBe(403);
  });

  it("returns 500 rather than opening access when membership verification fails", async () => {
    getAuth.mockReturnValue({ userId: "user_error" });
    resolveActiveTesterScope.mockRejectedValue(new Error("database unavailable"));

    const res = await request(app).get("/api/videos");

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      error: expect.stringContaining("verify pilot access"),
    });
  });

  it.each(["/api/account", "/api/account/"])(
    "keeps account deletion available after pilot membership ends for %s",
    async (path) => {
      getAuth.mockReturnValue({ userId: "user_former_pilot" });

      const res = await request(app).delete(path);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, userId: "user_former_pilot" });
      expect(resolveActiveTesterScope).not.toHaveBeenCalled();
      expect(resolveIdentity).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["GET", "/api/me"],
    ["GET", "/api/me/"],
    ["GET", "/api/testing/telemetry/context"],
    ["GET", "/api/testing/telemetry/context/"],
    ["GET", "/api/testing/telemetry/export"],
    ["GET", "/api/testing/telemetry/export/"],
    ["POST", "/api/testing/telemetry/withdraw"],
    ["POST", "/api/testing/telemetry/withdraw/"],
  ])(
    "keeps former tester privacy action %s %s reachable without active membership",
    async (method, path) => {
      getAuth.mockReturnValue({ userId: "user_former_pilot" });

      const res =
        method === "POST"
          ? await request(app).post(path).send({})
          : await request(app).get(path);

      expect(res.status).toBe(200);
      expect(resolveActiveTesterScope).not.toHaveBeenCalled();
      expect(resolveIdentity).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["POST", "/api/testing/telemetry/consents"],
    ["POST", "/api/testing/sessions/start"],
    ["GET", "/api/videos"],
  ])(
    "does not broaden former tester access through %s %s",
    async (method, path) => {
      getAuth.mockReturnValue({ userId: "user_former_pilot" });
      resolveActiveTesterScope.mockResolvedValue({
        scope: null,
        reason: "not_enrolled",
      });
      resolveIdentity.mockResolvedValue({
        userId: "user_former_pilot",
        email: "former@example.test",
        name: "Former Tester",
        isAdmin: false,
        isPresentation: false,
        classification: "resolved",
      });

      const res =
        method === "POST"
          ? await request(app).post(path).send({})
          : await request(app).get(path);

      expect(res.status).toBe(403);
      expect(resolveActiveTesterScope).toHaveBeenCalledWith("user_former_pilot");
    },
  );

  it.each([
    "/api/testing/reports/scopes",
    "/api/testing/reports/summary",
    "/api/testing/progress",
    "/api/testing/reports/scopes/",
    "/api/testing/reports/summary/",
    "/api/testing/progress/",
  ])("preserves route-scoped report authorization for %s", async (path) => {
    getAuth.mockReturnValue({ userId: "user_report_admin" });

    const res = await request(app).get(path);

    expect(res.status).toBe(200);
    expect(resolveActiveTesterScope).not.toHaveBeenCalled();
    expect(resolveIdentity).not.toHaveBeenCalled();
  });

  it("preserves the explicit local/test auth bypass", async () => {
    process.env["PILOT_AUTH_BYPASS"] = "true";

    const res = await request(app).get("/api/videos");

    expect(res.status).toBe(200);
    expect(resolveActiveTesterScope).not.toHaveBeenCalled();
  });
});
