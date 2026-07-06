/**
 * Request-level guard tests for the remaining admin-only Knowledge Review
 * routes in `graph.ts` — everything gated the same way as
 * PATCH /graph/nodes/:id/verification (covered separately) but not yet
 * proven at the HTTP layer:
 *
 *   - POST /graph/candidates/:id/resolve         (requireAdmin)
 *   - GET  /graph/mentor-contributions            (requireAdmin)
 *   - GET  /graph/health                          (requireAdmin)
 *   - GET  /graph/candidates?status=<non-pending> (inline resolveAdminIdentity)
 *
 * The API holds the Supabase service-role key with no other auth boundary, so
 * a regression on any of these would silently expose privileged actions
 * (mutating the shared graph, or reading mentor/telemetry data) to non-admins.
 * These tests exercise the real HTTP wiring (requireAdmin / resolveAdminIdentity
 * + the handler) against a mocked Clerk: anonymous callers are rejected with
 * 401, signed-in non-admins with 403, and a signed-in admin is accepted (2xx).
 *
 * The Supabase-backed lib (`memory-graph.ts`) is mocked — the point here is the
 * request-layer authorization boundary, not the graph writes themselves.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

// admin-auth reads ADMIN_EMAILS once at module-load time, so set it before any
// import resolves. vi.hoisted runs before the static imports below.
vi.hoisted(() => {
  process.env["ADMIN_EMAILS"] = "admin@torchlabs.ca";
});

// Mock Clerk so server-side identity resolution is deterministic and never
// touches a real Clerk backend.
const getAuth = vi.hoisted(() => vi.fn());
const getUser = vi.hoisted(() => vi.fn());
vi.mock("@clerk/express", () => ({
  getAuth,
  clerkClient: { users: { getUser } },
}));

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

const CANDIDATE_ID = "cand:porosity-mystery";

/**
 * Put a signed-in user behind the request. Default is the admin allowlist email;
 * pass role "user" for a signed-in non-admin. Not calling this (the default in
 * beforeEach) simulates an anonymous caller — getAuth returns undefined.
 */
function signInAs(role: "admin" | "user"): void {
  getAuth.mockReturnValue({ userId: role === "admin" ? "u_admin" : "u_reg" });
  const email = role === "admin" ? "admin@torchlabs.ca" : "regular@example.com";
  getUser.mockResolvedValue({
    firstName: null,
    lastName: null,
    primaryEmailAddress: { emailAddress: email },
    emailAddresses: [{ emailAddress: email }],
  });
}

function makeApp(): Express {
  const app = express();
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
  getAuth.mockReset();
  getUser.mockReset();
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

  it("rejects a signed-in non-admin with 403 and never touches the graph", async () => {
    signInAs("user");

    const res = await request(app)
      .post(`/api/graph/candidates/${CANDIDATE_ID}/resolve`)
      .send({ action: "accept" });

    expect(res.status).toBe(403);
    expect(resolveKnowledgeCandidate).not.toHaveBeenCalled();
  });

  it("accepts an admin and resolves the candidate", async () => {
    signInAs("admin");
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

  it("rejects a signed-in non-admin with 403 and never touches the graph", async () => {
    signInAs("user");

    const res = await request(app).get("/api/graph/mentor-contributions");

    expect(res.status).toBe(403);
    expect(getMentorContributionStats).not.toHaveBeenCalled();
  });

  it("accepts an admin and returns contribution stats", async () => {
    signInAs("admin");
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

    const res = await request(app).get("/api/graph/mentor-contributions");

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

  it("rejects a signed-in non-admin with 403 and never touches the graph", async () => {
    signInAs("user");

    const res = await request(app).get("/api/graph/health");

    expect(res.status).toBe(403);
    expect(getGraphHealth).not.toHaveBeenCalled();
  });

  it("accepts an admin and returns the health report", async () => {
    signInAs("admin");
    getGraphHealth.mockResolvedValue({
      counts: { verified: 1, partial: 0, failed: 0, pending: 0, total: 1 },
      retryQueue: { videos: 0, answers: 0, total: 0 },
      avgProcessingMs: null,
      recentWrites: [],
    });

    const res = await request(app).get("/api/graph/health");

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

  it("rejects an anonymous caller requesting a non-pending status with 403", async () => {
    const res = await request(app).get("/api/graph/candidates").query({ status: "accepted" });

    expect(res.status).toBe(403);
    expect(listKnowledgeCandidates).not.toHaveBeenCalled();
  });

  it("rejects a signed-in non-admin requesting a non-pending status with 403", async () => {
    signInAs("user");

    const res = await request(app).get("/api/graph/candidates").query({ status: "rejected" });

    expect(res.status).toBe(403);
    expect(listKnowledgeCandidates).not.toHaveBeenCalled();
  });

  it("allows an admin to read a non-pending status", async () => {
    signInAs("admin");
    listKnowledgeCandidates.mockResolvedValue([]);

    const res = await request(app).get("/api/graph/candidates").query({ status: "archived" });

    expect(res.status).toBe(200);
    expect(listKnowledgeCandidates).toHaveBeenCalledWith("archived");
  });
});
