/**
 * Route-level proof that trust-driven reranking is actually WIRED INTO the two
 * retrieval endpoints — POST /search and POST /chat — not just unit-tested in
 * isolation (the pure scoring logic lives in
 * ../../lib/__tests__/verification-rerank.test.ts).
 *
 * A future refactor of search.ts or chat.ts could silently stop calling
 * fetchVerificationCoverage / rerankByVerification, and every pure-function test
 * would still pass while Ask Jack quietly began citing rejected content again.
 * These tests drive the real Express handlers end-to-end over the shared
 * fake-supabase harness and assert the observable contract:
 *   1. a segment covered only by a REJECTED concept never appears in /search
 *      results or in Ask Jack's citations, and
 *   2. a segment covered by a VERIFIED concept outranks a neutral segment that
 *      had a HIGHER raw similarity — i.e. the reviewer boost measurably reorders
 *      the output, so we know the rerank ran.
 *
 * Only the true externals are mocked: Supabase (in-memory fake), OpenAI
 * (deterministic embeddings + a canned completion), the rate limiter
 * (pass-through), and the Vitality SSE publish (no-op). Retrieval, provenance
 * coverage lookup, and reranking all run for real.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

vi.mock("../../lib/supabase.js", async () => {
  const m = await import("../../lib/__tests__/mocks.js");
  return { supabase: m.fake };
});

vi.mock("../../lib/openai.js", async () => {
  const m = await import("../../lib/__tests__/mocks.js");
  return {
    createEmbedding: m.createEmbedding,
    // Ask Jack only needs a deterministic, offline answer; its prose is
    // irrelevant to the reranking assertions (we inspect citations, not text).
    chatCompletion: vi.fn(async () => ({
      choices: [{ message: { content: "Grounded answer." } }],
    })),
    MODELS: m.MODELS,
    openai: m.openai,
  };
});

// Rate limiting and the Vitality event bus are orthogonal to reranking; stub
// them so the exercised path is purely retrieval -> coverage -> rerank.
vi.mock("../../lib/rate-limit.js", () => ({
  aiQueryLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../lib/vitality.js", () => ({ publish: vi.fn() }));

import searchRouter from "../search.js";
import chatRouter from "../chat.js";
import { fake, embedRegistry, resetMocks } from "../../lib/__tests__/mocks.js";

// A query whose embedding we pin so segment similarity is fully deterministic.
const QUERY = "how do I prevent weld porosity";

// Three source videos, one segment each. Raw similarity (cosine vs the pinned
// query vector [1,0]) is chosen so the NEUTRAL segment out-scores the VERIFIED
// one before reranking — the verified boost has to flip that order.
const V_VERIFIED = "11111111-1111-1111-1111-111111111111";
const V_NEUTRAL = "22222222-2222-2222-2222-222222222222";
const V_REJECTED = "33333333-3333-3333-3333-333333333333";

/** A 2-D unit vector whose cosine with the query vector [1,0] is exactly `c`. */
function unit(c: number): string {
  return JSON.stringify([c, Math.sqrt(1 - c * c)]);
}

function seed(): void {
  resetMocks();
  embedRegistry.set(QUERY, [1, 0]);

  fake.tables["videos"] = [
    { id: V_VERIFIED, title: "Verified clip", thumbnail_url: "v.jpg", trade: "Welder" },
    { id: V_NEUTRAL, title: "Neutral clip", thumbnail_url: "n.jpg", trade: "Welder" },
    { id: V_REJECTED, title: "Rejected clip", thumbnail_url: "r.jpg", trade: "Welder" },
  ];

  fake.tables["transcript_segments"] = [
    // verified: LOWER raw score (0.60) — must still win after the +0.15 boost.
    { id: "s-ver", video_id: V_VERIFIED, start_time: 60, end_time: 70, text: "shield the pool", embedding: unit(0.6) },
    // neutral: HIGHER raw score (0.70), no covering concept.
    { id: "s-neu", video_id: V_NEUTRAL, start_time: 10, end_time: 20, text: "grind the joint", embedding: unit(0.7) },
    // rejected: any score above the 0.5 threshold — it must be dropped regardless.
    { id: "s-rej", video_id: V_REJECTED, start_time: 30, end_time: 40, text: "bad advice", embedding: unit(0.65) },
  ];

  // Provenance edges tie each concept to its source video (video:<id> -> concept),
  // which is how fetchVerificationCoverage resolves the concepts for a video.
  fake.tables["knowledge_edges"] = [
    { id: "e-ver", source_id: `video:${V_VERIFIED}`, target_id: "k:concept:verified", kind: "knowledge", weight: 1, meta: {} },
    { id: "e-rej", source_id: `video:${V_REJECTED}`, target_id: "k:concept:rejected", kind: "knowledge", weight: 1, meta: {} },
    // V_NEUTRAL intentionally has no knowledge edge -> it stays neutral.
  ];

  // Each concept carries the reviewer decision plus a source timestamp that falls
  // inside the matching segment's (padded) window — the only bridge the reranker
  // uses to map a concept back onto a retrieved segment.
  fake.tables["knowledge_nodes"] = [
    {
      id: "k:concept:verified",
      verification_status: "verified",
      confidence: 0.5,
      meta: { sources: [{ videoId: V_VERIFIED, timestamps: [62] }], sourceCount: 1 },
    },
    {
      id: "k:concept:rejected",
      verification_status: "rejected",
      confidence: 0.5,
      meta: { sources: [{ videoId: V_REJECTED, timestamps: [33] }], sourceCount: 1 },
    },
  ];
}

function makeApp(): Express {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  // The real app wires req.log via pino-http; handlers call req.log.error, so
  // provide a no-op logger for the test app.
  app.use((req, _res, next) => {
    const noop = () => {};
    (req as unknown as { log: Record<string, () => void> }).log = {
      warn: noop,
      error: noop,
      info: noop,
      debug: noop,
    };
    // Stand in for the app-level requireAuth gate: the chat route now owns
    // messages by the server-derived Clerk user id, so give the request one.
    (req as unknown as { userId: string }).userId = "user_test";
    next();
  });
  app.use("/api", searchRouter);
  app.use("/api", chatRouter);
  return app;
}

const app = makeApp();

beforeEach(() => {
  seed();
});

describe("POST /search — honors reviewer decisions end-to-end", () => {
  it("drops a segment covered only by a rejected concept", async () => {
    const res = await request(app).post("/api/search").send({ query: QUERY });
    expect(res.status).toBe(200);
    const ids = (res.body.results as Array<{ videoId: string }>).map((r) => r.videoId);
    expect(ids).not.toContain(V_REJECTED);
    // Sanity: the other two survived, so the drop isn't just an empty result.
    expect(ids).toContain(V_VERIFIED);
    expect(ids).toContain(V_NEUTRAL);
  });

  it("boosts a verified segment above a higher-raw-score neutral one", async () => {
    const res = await request(app).post("/api/search").send({ query: QUERY });
    expect(res.status).toBe(200);
    const results = res.body.results as Array<{ videoId: string; score: number }>;
    const ver = results.find((r) => r.videoId === V_VERIFIED);
    const neu = results.find((r) => r.videoId === V_NEUTRAL);
    expect(ver).toBeDefined();
    expect(neu).toBeDefined();
    // Reviewer boost applied: 0.60 raw + 0.15 -> 0.75, above the neutral 0.70.
    expect(ver!.score).toBeCloseTo(0.75, 5);
    expect(neu!.score).toBeCloseTo(0.7, 5);
    expect(ver!.score).toBeGreaterThan(neu!.score);
    // ...and that reordered the output: verified now ranks ahead of the neutral
    // segment that had the higher raw similarity.
    const order = results.map((r) => r.videoId);
    expect(order.indexOf(V_VERIFIED)).toBeLessThan(order.indexOf(V_NEUTRAL));
  });
});

describe("POST /chat — Ask Jack never cites rejected content", () => {
  it("omits the rejected segment from citations and badges the verified one", async () => {
    const res = await request(app).post("/api/chat").send({ message: QUERY });
    expect(res.status).toBe(200);
    expect(res.body.usedInternalKnowledge).toBe(true);

    const videoCites = (res.body.citations as Array<{
      videoId: string;
      sourceType: string;
      verified?: boolean;
    }>).filter((c) => c.sourceType === "video");
    const ids = videoCites.map((c) => c.videoId);

    // The rejected concept's segment is never surfaced to the model or the user.
    expect(ids).not.toContain(V_REJECTED);

    // The verified segment is present and carries the reviewer trust flag.
    const ver = videoCites.find((c) => c.videoId === V_VERIFIED);
    expect(ver).toBeDefined();
    expect(ver!.verified).toBe(true);

    // The verified segment is boosted above the higher-raw-score neutral one.
    expect(ids.indexOf(V_VERIFIED)).toBeLessThan(ids.indexOf(V_NEUTRAL));
  });
});
