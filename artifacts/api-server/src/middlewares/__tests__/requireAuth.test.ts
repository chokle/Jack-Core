/**
 * Request-level tests for the app-wide authentication gate (`requireAuth`).
 *
 * This is the single boundary that makes the whole `/api` surface fail-closed:
 * `app.ts` mounts it as `app.use("/api", requireAuth)` after `clerkMiddleware`,
 * so a direct-URL / incognito hit to any non-public route is rejected with 401
 * regardless of the frontend. The per-router unit tests deliberately mount
 * routers on a bare app WITHOUT this gate, so without this file the gate itself
 * — and the exact set of PUBLIC_API_PATHS — has zero coverage. A typo in that
 * set, or a regression in the mount-path-relative matching, would silently open
 * the API to anonymous callers.
 *
 * The test mounts the real middleware the same way the app does
 * (`app.use("/api", requireAuth)`) so it exercises the mount-path stripping
 * (a request to `/api/healthz` arrives as `req.path === "/healthz"`), against a
 * mocked Clerk `getAuth`.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

const getAuth = vi.hoisted(() => vi.fn());
vi.mock("@clerk/express", () => ({ getAuth }));

import { requireAuth } from "../requireAuth.js";

function makeApp(): Express {
  const app = express();
  // Match app.ts: a no-op req.log (pino-http in prod) is available to handlers.
  app.use((req, _res, next) => {
    (req as unknown as { log: { warn: () => void } }).log = { warn: () => {} };
    next();
  });
  // The real composition layer: gate the whole /api surface, then serve.
  app.use("/api", requireAuth);
  app.all(/.*/, (req, res) => {
    res.status(200).json({ ok: true, userId: (req as { userId?: string }).userId ?? null });
  });
  return app;
}

const app = makeApp();

beforeEach(() => {
  getAuth.mockReset();
});

describe("requireAuth — public paths (no auth required)", () => {
  it.each(["/api/", "/api/healthz", "/api/system-health"])(
    "allows anonymous access to %s",
    async (path) => {
      const res = await request(app).get(path);

      expect(res.status).toBe(200);
      // getAuth is never consulted for public paths.
      expect(getAuth).not.toHaveBeenCalled();
    },
  );
});

describe("requireAuth — protected paths", () => {
  it("rejects an anonymous request to a non-public route with 401", async () => {
    getAuth.mockReturnValue({ userId: null });

    const res = await request(app).get("/api/videos");

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: expect.stringContaining("Unauthorized") });
  });

  it("rejects when getAuth returns no auth object (clerkMiddleware absent) with 401", async () => {
    getAuth.mockReturnValue(undefined);

    const res = await request(app).get("/api/videos");

    expect(res.status).toBe(401);
  });

  it("treats a throwing getAuth as unauthenticated (401), never a 500", async () => {
    getAuth.mockImplementation(() => {
      throw new Error("clerkMiddleware did not run");
    });

    const res = await request(app).post("/api/videos/ingest").send({});

    expect(res.status).toBe(401);
  });

  it("allows a signed-in caller through and populates req.userId", async () => {
    getAuth.mockReturnValue({ userId: "u_123" });

    const res = await request(app).get("/api/videos");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, userId: "u_123" });
  });

  it("lets CORS preflight (OPTIONS) through without auth so the browser can learn the route is allowed", async () => {
    const res = await request(app).options("/api/videos");

    expect(res.status).toBe(200);
    expect(getAuth).not.toHaveBeenCalled();
  });
});
