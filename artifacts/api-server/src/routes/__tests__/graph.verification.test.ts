/**
 * Request-level guard tests for PATCH /graph/nodes/:id/verification — the only
 * route that mutates trusted-knowledge state. The API holds the Supabase
 * service-role key, so a regression that lets a non-admin rewrite verification
 * status would be a full trust breach. These tests exercise the real HTTP
 * wiring (requireAdmin + the handler) against a mocked Clerk: an anonymous
 * caller must be rejected with 401, a signed-in non-admin with 403, a signed-in
 * admin accepted, and an unknown / non-knowledge node id must 404.
 *
 * The Supabase-backed lib (setNodeVerification) is mocked — the point here is the
 * request-layer authorization boundary, not the graph write itself (that logic
 * is covered by the memory-graph lib unit tests).
 */
import { vi, describe, it, expect, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

// admin-auth reads ADMIN_EMAILS once at module-load time, so set it before any
// import resolves. vi.hoisted runs before the static imports below.
vi.hoisted(() => {
  process.env["ADMIN_EMAILS"] = "admin@torchlabs.ca";
});

// Mock Clerk so the route's server-side identity resolution is deterministic and
// never touches a real Clerk backend. getAuth yields the session; clerkClient
// resolves the email that decides admin status.
const getAuth = vi.hoisted(() => vi.fn());
const getUser = vi.hoisted(() => vi.fn());
vi.mock("@clerk/express", () => ({
  getAuth,
  clerkClient: { users: { getUser } },
}));

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
  restoreWithdrawnEvidence: vi.fn(),
  getGraphHealth: vi.fn(),
}));

import graphRouter from "../graph.js";

const NODE_ID = "k:concept:porosity-prevention";

/**
 * Put a signed-in user behind the request. Default is the admin allowlist email;
 * pass role "user" for a signed-in non-admin. Leaving this unset (the default in
 * beforeEach) simulates an anonymous caller — getAuth returns undefined.
 */
function signInAs(
  role: "admin" | "user",
  opts?: { firstName?: string; lastName?: string },
): void {
  getAuth.mockReturnValue({ userId: role === "admin" ? "u_admin" : "u_reg" });
  const email = role === "admin" ? "admin@torchlabs.ca" : "regular@example.com";
  getUser.mockResolvedValue({
    firstName: opts?.firstName ?? null,
    lastName: opts?.lastName ?? null,
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

  it("rejects a signed-in non-admin with 403 and never touches the graph", async () => {
    signInAs("user");

    const res = await request(app)
      .patch(`/api/graph/nodes/${NODE_ID}/verification`)
      .send({ status: "verified" });

    expect(res.status).toBe(403);
    expect(setNodeVerification).not.toHaveBeenCalled();
  });

  it("accepts an admin and returns the updated node", async () => {
    signInAs("admin");
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
      .send({ status: "verified" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: NODE_ID, verificationStatus: "verified" });
    // No name on the admin's Clerk profile → attributed to their email (a real,
    // resolved identity), never a client-supplied field.
    expect(setNodeVerification).toHaveBeenCalledWith(NODE_ID, "verified", "admin@torchlabs.ca");
  });

  it("attributes the decision to the signed-in admin, ignoring any body-supplied identity", async () => {
    signInAs("admin", { firstName: "Dana", lastName: "Welder" });
    setNodeVerification.mockResolvedValue({
      id: NODE_ID,
      kind: "concept",
      label: "Porosity Prevention",
      trade: "Welder",
      refId: null,
      description: null,
      confidence: 0.9,
      verificationStatus: "verified",
      meta: {},
    });

    const res = await request(app)
      .patch(`/api/graph/nodes/${NODE_ID}/verification`)
      // A malicious body claims a different reviewer — it must be ignored.
      .send({ status: "verified", reviewer: "Someone Else" });

    expect(res.status).toBe(200);
    expect(setNodeVerification).toHaveBeenCalledWith(NODE_ID, "verified", "Dana Welder");
  });
});

describe("PATCH /graph/nodes/:id/verification — validation & 404", () => {
  it("rejects an invalid status value with 400 before hitting the graph", async () => {
    signInAs("admin");

    const res = await request(app)
      .patch(`/api/graph/nodes/${NODE_ID}/verification`)
      .send({ status: "totally-bogus" });

    expect(res.status).toBe(400);
    expect(setNodeVerification).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown / non-knowledge node id", async () => {
    signInAs("admin");
    setNodeVerification.mockResolvedValue(null);

    const res = await request(app)
      .patch(`/api/graph/nodes/video:not-a-concept/verification`)
      .send({ status: "verified" });

    expect(res.status).toBe(404);
    expect(setNodeVerification).toHaveBeenCalledWith(
      "video:not-a-concept",
      "verified",
      "admin@torchlabs.ca",
    );
  });
});
