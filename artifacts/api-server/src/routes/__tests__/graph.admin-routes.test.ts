/**
 * Request-level guard tests for the remaining admin-only Knowledge Review
 * routes in `graph.ts` — everything gated the same way as
 * PATCH /graph/nodes/:id/verification (covered separately) but not yet
 * proven at the HTTP layer:
 *
 *   - POST /graph/candidates/:id/resolve        (requireAdminSession)
 *   - GET  /graph/mentor-contributions           (requireAdminSession)
 *   - GET  /graph/health                         (requireAdminSession)
 *   - GET  /graph/candidates?status=<non-pending> (inline isAdminSessionValid check)
 *
 * The API holds the Supabase service-role key with no other auth boundary, so
 * a regression on any of these would silently expose privileged actions
 * (mutating the shared graph, or reading mentor/telemetry data) to anonymous
 * callers. These tests exercise the real HTTP wiring (cookie-parser +
 * requireAdminSession / isAdminSessionValid + the handler): anonymous callers
 * must be rejected with 401 and never reach the graph lib, while a valid
 * signed admin session must be accepted (2xx).
 *
 * The Supabase-backed lib (`memory-graph.ts`) is mocked — the point here is
 * the request-layer authorization boundary, not the graph writes themselves.
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

const resolveKnowledgeCandidate = vi.hoisted(() => vi.fn());
const listKnowledgeCandidates = vi.hoisted(() => vi.fn());
const getMentorContributionStats = vi.hoisted(() => vi.fn());
const getGraphHealth = vi.hoisted(() => vi.fn());

vi.mock("../../lib/memory-graph.js", () => ({
  getGraph: vi.fn(),
  rebuildGraph: vi.fn(),
  setNodeVerification: vi.fn(),
  restoreWithdrawnEvidence: vi.fn(),
  listKnowledgeCandidates,
  getMentorContributionStats,
  resolveKnowledgeCandidate,
  getGraphHealth,
}));

import graphRouter from "../graph.js";
import { createAdminSession } from "../../lib/admin-auth.js";

const CANDIDATE_ID = "cand:porosity-mystery";

/** Build a valid signed session cookie by driving the real login machinery. */
function adminCookie(reviewer?: string): string {
  let cookie = "";
  const fakeRes = {
    cookie(name: string, value: string) {
      cookie = `${name}=${value}`;
      return this;
    },
  } as unknown as Response;
  const result = createAdminSession(ADMIN_KEY, fakeRes, reviewer);
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
  resolveKnowledgeCandidate.mockReset();
  listKnowledgeCandidates.mockReset();
  getMentorContributionStats.mockReset();
  getGraphHealth.mockReset();
});

describe("POST /graph/candidates/:id/resolve — authorization", () => {
  it("rejects an anonymous caller with 401 and never touches the graph", async () => {
    const res = await request(app)
      .post(`/api/graph/candidates/${CANDIDATE_ID}/resolve`)
      .send({ action: "accept" });

    expect(res.status).toBe(401);
    expect(resolveKnowledgeCandidate).not.toHaveBeenCalled();
  });

  it("rejects a caller presenting a forged/invalid session cookie with 401", async () => {
    const res = await request(app)
      .post(`/api/graph/candidates/${CANDIDATE_ID}/resolve`)
      .set("Cookie", "jack_admin_session=authenticated.deadbeefsignature")
      .send({ action: "accept" });

    expect(res.status).toBe(401);
    expect(resolveKnowledgeCandidate).not.toHaveBeenCalled();
  });

  it("accepts a valid admin session and resolves the candidate", async () => {
    resolveKnowledgeCandidate.mockResolvedValue({
      ok: true,
      replayed: false,
      candidate: {
        id: CANDIDATE_ID,
        status: "accepted",
        title: "Porosity prevention",
        description: null,
        category: "concept",
        trade: "Welder",
        confidence: 0.8,
        competencyCode: null,
        mentorProfileId: "mentor-1",
        mentorName: "Dana",
        answerId: null,
        sessionId: null,
        bestMatches: [],
        createdAt: null,
        resolvedTargetId: null,
        resolutionReason: null,
        resolvedAt: null,
        requestedTargetId: null,
        redirectReason: null,
      },
    });

    const res = await request(app)
      .post(`/api/graph/candidates/${CANDIDATE_ID}/resolve`)
      .set("Cookie", adminCookie())
      .send({ action: "accept" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: CANDIDATE_ID, status: "accepted" });
    expect(resolveKnowledgeCandidate).toHaveBeenCalledWith(CANDIDATE_ID, "accept", {
      targetNodeId: null,
      reason: null,
    });
  });
});

describe("GET /graph/mentor-contributions — authorization", () => {
  it("rejects an anonymous caller with 401 and never touches the graph", async () => {
    const res = await request(app).get("/api/graph/mentor-contributions");

    expect(res.status).toBe(401);
    expect(getMentorContributionStats).not.toHaveBeenCalled();
  });

  it("rejects a caller presenting a forged/invalid session cookie with 401", async () => {
    const res = await request(app)
      .get("/api/graph/mentor-contributions")
      .set("Cookie", "jack_admin_session=authenticated.deadbeefsignature");

    expect(res.status).toBe(401);
    expect(getMentorContributionStats).not.toHaveBeenCalled();
  });

  it("accepts a valid admin session and returns contribution stats", async () => {
    getMentorContributionStats.mockResolvedValue([
      {
        mentorProfileId: "mentor-1",
        conceptsCreated: 2,
        conceptsReinforced: 1,
        accepted: 3,
        rejected: 1,
        pending: 0,
      },
    ]);

    const res = await request(app)
      .get("/api/graph/mentor-contributions")
      .set("Cookie", adminCookie());

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 1 });
    expect(getMentorContributionStats).toHaveBeenCalledTimes(1);
  });
});

describe("GET /graph/health — authorization", () => {
  it("rejects an anonymous caller with 401 and never touches the graph", async () => {
    const res = await request(app).get("/api/graph/health");

    expect(res.status).toBe(401);
    expect(getGraphHealth).not.toHaveBeenCalled();
  });

  it("rejects a caller presenting a forged/invalid session cookie with 401", async () => {
    const res = await request(app)
      .get("/api/graph/health")
      .set("Cookie", "jack_admin_session=authenticated.deadbeefsignature");

    expect(res.status).toBe(401);
    expect(getGraphHealth).not.toHaveBeenCalled();
  });

  it("accepts a valid admin session and returns the health report", async () => {
    getGraphHealth.mockResolvedValue({
      counts: { verified: 1, partial: 0, failed: 0, pending: 0, total: 1 },
      retryQueue: { videos: 0, answers: 0, total: 0 },
      avgProcessingMs: null,
      recentWrites: [],
    });

    const res = await request(app).get("/api/graph/health").set("Cookie", adminCookie());

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ counts: { total: 1 } });
    expect(getGraphHealth).toHaveBeenCalledTimes(1);
  });
});

describe("GET /graph/candidates?status=<non-pending> — authorization", () => {
  it("allows an anonymous caller to read the default pending list", async () => {
    listKnowledgeCandidates.mockResolvedValue([]);

    const res = await request(app).get("/api/graph/candidates");

    expect(res.status).toBe(200);
    expect(listKnowledgeCandidates).toHaveBeenCalledWith("pending");
  });

  it("allows an anonymous caller to explicitly request status=pending", async () => {
    listKnowledgeCandidates.mockResolvedValue([]);

    const res = await request(app).get("/api/graph/candidates").query({ status: "pending" });

    expect(res.status).toBe(200);
    expect(listKnowledgeCandidates).toHaveBeenCalledWith("pending");
  });

  it("rejects an anonymous caller requesting a non-pending status with 401", async () => {
    const res = await request(app).get("/api/graph/candidates").query({ status: "accepted" });

    expect(res.status).toBe(401);
    expect(listKnowledgeCandidates).not.toHaveBeenCalled();
  });

  it("rejects a forged/invalid session cookie requesting a non-pending status with 401", async () => {
    const res = await request(app)
      .get("/api/graph/candidates")
      .query({ status: "rejected" })
      .set("Cookie", "jack_admin_session=authenticated.deadbeefsignature");

    expect(res.status).toBe(401);
    expect(listKnowledgeCandidates).not.toHaveBeenCalled();
  });

  it("allows a valid admin session to read a non-pending status", async () => {
    listKnowledgeCandidates.mockResolvedValue([]);

    const res = await request(app)
      .get("/api/graph/candidates")
      .query({ status: "archived" })
      .set("Cookie", adminCookie());

    expect(res.status).toBe(200);
    expect(listKnowledgeCandidates).toHaveBeenCalledWith("archived");
  });
});
