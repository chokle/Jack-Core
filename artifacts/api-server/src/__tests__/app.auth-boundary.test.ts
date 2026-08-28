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

  it("sets Jack's enforced HTTP Content-Security-Policy on successful responses", async () => {
    const response = await request(app).get("/api/healthz");
    const policy = response.headers["content-security-policy"];

    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("https://challenges.cloudflare.com");
    expect(policy).toContain("https://*.supabase.co");
    expect(policy).toContain("https://clerk.jack.torchlabs.ca");
    expect(policy).toContain("https://clerk.staging.jack.torchlabs.ca");
    expect(policy).not.toContain("https://*.torchlabs.ca");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'self'");
  });

  it("keeps a CSP header on the root path when the frontend build is absent", async () => {
    const response = await request(app).get("/");

    // In source-only unit tests there is no dist/public build, so Express emits
    // its synthetic 404 with the stricter `default-src 'none'` policy. The
    // production-container smoke test verifies Jack's exact policy on the built
    // root document.
    expect(response.headers["content-security-policy"]).toBeTruthy();
  });

  it("preserves a verified Clerk subject for authenticated routes", async () => {
    getAuth.mockReturnValue({ userId: "user_secure" });

    const response = await request(app).get("/api/me");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ userId: "user_secure" });
  });
});
