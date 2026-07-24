import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const getAuth = vi.hoisted(() => vi.fn());
vi.mock("@clerk/express", () => ({
  getAuth,
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../middlewares/clerkProxyMiddleware.js", () => ({
  CLERK_PROXY_PATH: "/api/__clerk",
  clerkProxyMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("pino-http", () => ({
  default: () => (req: { log?: unknown }, _res: unknown, next: () => void) => {
    req.log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    next();
  },
}));
vi.mock("../routes/index.js", async () => {
  const express = await import("express");
  const router = express.Router();
  router.get("/me", (req, res) => res.json({ userId: req.userId }));
  router.get("/healthz", (_req, res) => res.json({ ok: true }));
  return { default: router };
});
vi.mock("../lib/logger.js", () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock("../lib/vitality.js", () => ({ publish: vi.fn() }));

import app from "../app.js";

beforeEach(() => {
  getAuth.mockReset();
});

describe("app-wide authentication composition", () => {
  it("rejects an anonymous direct request to a real /api route", async () => {
    getAuth.mockReturnValue({ userId: null });

    const response = await request(app).get("/api/me");

    expect(response.status).toBe(401);
    expect(response.body.error).toContain("sign in required");
  });

  it("allows the health probe without a session", async () => {
    const response = await request(app).get("/api/healthz");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });

  it("preserves a verified Clerk subject for authenticated routes", async () => {
    getAuth.mockReturnValue({ userId: "user_secure" });

    const response = await request(app).get("/api/me");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ userId: "user_secure" });
  });
});
