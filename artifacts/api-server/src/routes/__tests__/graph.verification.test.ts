/**
 * Request-level guard tests for PATCH /graph/nodes/:id/verification — the only
 * route that mutates trusted-knowledge state. The API holds the Supabase
 * service-role key and has no other auth boundary, so a regression that lets an
 * anonymous caller rewrite verification status would be a full trust breach.
 * These tests exercise the real HTTP wiring (cookie-parser + requireAdminSession
 * + the handler): anonymous callers must be rejected, a valid signed admin
 * session must be accepted, and an unknown / non-knowledge node id must 404.
 *
 * The Supabase-backed lib (setNodeVerification) is mocked — the point here is the
 * request-layer authorization boundary, not the graph write itself (that logic
 * is covered by the memory-graph lib unit tests).
 */
import { vi, describe, it, expect, beforeEach } from "vitest";
import express, { type Express, type Response } from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

// admin-auth reads JACK_ADMIN_KEY at module-load time, so set it before any
// import resolves. vi.hoisted runs before the static imports below.
const ADMIN_KEY = vi.hoisted(() => {
  const key = "test-admin-key-1234567890";
  process.env["JACK_ADMIN_KEY"] = key;
  return key;
});

// Mock the Supabase-backed graph lib so the route never touches a real DB. Only
// setNodeVerification is used by this route; the rest are stubs to satisfy the
// module's import surface.
const setNodeVerification = vi.hoisted(() => vi.fn());
vi.mock("../../lib/memory-graph.js", () => ({
  setNodeVerification,
  getGraph: vi.fn(),
  rebuildGraph: vi.fn(),
  listKnowledgeCandidates: vi.fn(),
  getMentorContributionStats: vi.fn(),
  resolveKnowledgeCandidate: vi.fn(),
  getGraphHealth: vi.fn(),
}));

import graphRouter from "../graph.js";
import { createAdminSession } from "../../lib/admin-auth.js";

const NODE_ID = "k:concept:porosity-prevention";

/** Build a valid signed session cookie by driving the real login machinery. */
function adminCookie(): string {
  let cookie = "";
  const fakeRes = {
    cookie(name: string, value: string) {
      cookie = `${name}=${value}`;
      return this;
    },
  } as unknown as Response;
  const result = createAdminSession(ADMIN_KEY, fakeRes);
  expect(result).toBe("ok");
  return cookie;
}

function makeApp(): Express {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  // The real app wires req.log via pino-http; the route handlers call
  // req.log.{warn,error}, so provide a no-op logger for the test app.
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
  app.use("/api", graphRouter);
  return app;
}

const app = makeApp();

beforeEach(() => {
  setNodeVerification.mockReset();
});

describe("PATCH /graph/nodes/:id/verification — authorization", () => {
  it("rejects an anonymous caller with 401 and never touches the graph", async () => {
    const res = await request(app)
      .patch(`/api/graph/nodes/${NODE_ID}/verification`)
      .send({ status: "verified" });

    expect(res.status).toBe(401);
    expect(setNodeVerification).not.toHaveBeenCalled();
  });

  it("rejects a caller presenting a forged/invalid session cookie with 401", async () => {
    const res = await request(app)
      .patch(`/api/graph/nodes/${NODE_ID}/verification`)
      .set("Cookie", "jack_admin_session=authenticated.deadbeefsignature")
      .send({ status: "verified" });

    expect(res.status).toBe(401);
    expect(setNodeVerification).not.toHaveBeenCalled();
  });

  it("accepts a valid admin session and returns the updated node", async () => {
    const node = {
      id: NODE_ID,
      kind: "concept",
      label: "Porosity Prevention",
      trade: "Welder",
      refId: null,
      description: "Keep the weld pool shielded.",
      confidence: 0.9,
      verificationStatus: "verified",
      meta: {},
    };
    setNodeVerification.mockResolvedValue(node);

    const res = await request(app)
      .patch(`/api/graph/nodes/${NODE_ID}/verification`)
      .set("Cookie", adminCookie())
      .send({ status: "verified" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: NODE_ID, verificationStatus: "verified" });
    expect(setNodeVerification).toHaveBeenCalledWith(NODE_ID, "verified");
  });
});

describe("PATCH /graph/nodes/:id/verification — validation & 404", () => {
  it("rejects an invalid status value with 400 before hitting the graph", async () => {
    const res = await request(app)
      .patch(`/api/graph/nodes/${NODE_ID}/verification`)
      .set("Cookie", adminCookie())
      .send({ status: "totally-bogus" });

    expect(res.status).toBe(400);
    expect(setNodeVerification).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown / non-knowledge node id", async () => {
    setNodeVerification.mockResolvedValue(null);

    const res = await request(app)
      .patch(`/api/graph/nodes/video:not-a-concept/verification`)
      .set("Cookie", adminCookie())
      .send({ status: "verified" });

    expect(res.status).toBe(404);
    expect(setNodeVerification).toHaveBeenCalledWith("video:not-a-concept", "verified");
  });
});
