/**
 * End-to-end guard that trust actually steers semantic SEARCH through the REAL
 * /api/search path — the sibling of chat.rerank.test.ts, which proves the same
 * for Ask Jack. The pure boost math is covered in verification-rerank.test.ts;
 * this test proves the SEARCH route WIRES it up: that POST /api/search runs the
 * vector-search RPC, loads concept-trust coverage from knowledge_edges +
 * knowledge_nodes, reranks the retrieved segments, and returns them in trust
 * order. A refactor that detaches fetchVerificationCoverage / rerankByVerification
 * from the search handler would silently return results in raw-similarity order
 * and only a route-level test like this one would catch it.
 *
 * Unlike the chat citations, the search response surfaces only the reordered
 * `score` per result (not a verified/sourceCount flag), so the assertions here
 * are on the RESULT ORDER (which videoId comes first) and on DROPPING (a segment
 * covered only by a rejected concept must not appear) — exactly the observable
 * behavior a search client relies on.
 *
 * Scenario mirrors the chat test: two segments come back on the same topic —
 *   - a LONE, unreviewed, single-source mention with the HIGHER raw similarity, and
 *   - a mentor-VERIFIED concept CONFIRMED across several videos with a LOWER raw
 *     similarity.
 * Trust must flip the order so the verified/multi-video result is returned first.
 * A control case (same data, but the top concept left unverified and
 * single-source) proves the flip is caused by trust, not by chance ordering.
 *
 * Supabase and OpenAI are mocked: the shared in-memory FakeSupabase serves the
 * retrieval RPC + the edges/nodes reads (so the real coverage query runs), and
 * the OpenAI wrapper is stubbed so no embedding cost is incurred. Retrieval
 * scores are injected via each seeded segment's `similarity` field so the raw
 * ordering is pinned and the trust flip is unambiguous.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";
import express, { type Express, type Request } from "express";
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
    MODELS: m.MODELS,
    openai: m.openai,
  };
});

import searchRouter from "../search.js";
import { fake, resetMocks } from "../../lib/__tests__/mocks.js";

// A retrieved topic taught in one master-class video (VID_VERIFIED) and confirmed
// across two more (VID_CORROB_2/3), versus a one-off mention in VID_LONE.
const VID_VERIFIED = "11111111-1111-1111-1111-111111111111";
const VID_CORROB_2 = "22222222-2222-2222-2222-222222222222";
const VID_CORROB_3 = "33333333-3333-3333-3333-333333333333";
const VID_LONE = "99999999-9999-9999-9999-999999999999";

const CONCEPT_VERIFIED = "k:concept:torch-angle";
const CONCEPT_LONE = "k:concept:torch-lone";

/**
 * Seed the two competing retrieved segments. The lone mention deliberately has
 * the HIGHER raw similarity so that, absent trust, it would rank first.
 */
function seedSegments(): void {
  fake.tables["transcript_segments"] = [
    {
      video_id: VID_LONE,
      video_title: "One-off Clip",
      start_time: 100,
      end_time: 105,
      text: "Some guy mentions the torch angle once.",
      thumbnail_url: null,
      similarity: 0.72,
    },
    {
      video_id: VID_VERIFIED,
      video_title: "Master Class: Torch Control",
      start_time: 10,
      end_time: 15,
      text: "Hold a consistent 15-degree torch angle for an even bead.",
      thumbnail_url: null,
      similarity: 0.6,
    },
  ];
}

/**
 * Provenance edges tie each retrieved video to its distilled concept
 * (kind='knowledge'). fetchVerificationCoverage resolves these first, then reads
 * the concepts' trust fields — so both must be present for the route to rerank.
 */
function seedEdges(): void {
  fake.tables["knowledge_edges"] = [
    { source_id: `video:${VID_VERIFIED}`, target_id: CONCEPT_VERIFIED, kind: "knowledge" },
    { source_id: `video:${VID_CORROB_2}`, target_id: CONCEPT_VERIFIED, kind: "knowledge" },
    { source_id: `video:${VID_CORROB_3}`, target_id: CONCEPT_VERIFIED, kind: "knowledge" },
    { source_id: `video:${VID_LONE}`, target_id: CONCEPT_LONE, kind: "knowledge" },
  ];
}

function makeApp(): Express {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use((req: Request, _res, next) => {
    const noop = () => {};
    (req as unknown as { log: Record<string, () => void> }).log = {
      warn: noop,
      error: noop,
      info: noop,
      debug: noop,
    };
    next();
  });
  app.use("/api", searchRouter);
  return app;
}

const app = makeApp();

interface SearchResult {
  videoId: string;
  videoTitle: string;
  startTime: number;
  score: number;
}

beforeEach(() => {
  resetMocks();
});

describe("POST /api/search — trust steers results end-to-end", () => {
  it("ranks a mentor-verified, multi-video concept above a higher-similarity lone mention", async () => {
    seedSegments();
    seedEdges();
    fake.tables["knowledge_nodes"] = [
      {
        id: CONCEPT_VERIFIED,
        verification_status: "verified",
        confidence: 0.9,
        meta: {
          sourceCount: 3,
          sources: [
            { videoId: VID_VERIFIED, timestamps: [12] },
            { videoId: VID_CORROB_2, timestamps: [30] },
            { videoId: VID_CORROB_3, timestamps: [45] },
          ],
        },
      },
      {
        id: CONCEPT_LONE,
        verification_status: "unverified",
        confidence: 0.3,
        meta: { sourceCount: 1, sources: [{ videoId: VID_LONE, timestamps: [102] }] },
      },
    ];

    const res = await request(app).post("/api/search").send({ query: "What torch angle should I use?" });

    expect(res.status).toBe(200);
    const results = res.body.results as SearchResult[];
    expect(results).toHaveLength(2);

    // The verified, multi-video result is returned FIRST even though its raw
    // retrieval similarity (0.6) was lower than the lone mention's (0.72): the
    // reviewer bump + corroboration lifted its adjusted score above 0.72.
    expect(results[0]!.videoId).toBe(VID_VERIFIED);
    expect(results[1]!.videoId).toBe(VID_LONE);
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  it("control: with the top concept left unverified and single-source, the higher-similarity lone mention stays first", async () => {
    seedSegments();
    seedEdges();
    // Same retrieval, but the torch-angle concept is now an unreviewed one-off —
    // no reviewer bump, no corroboration bump — so nothing outweighs raw
    // similarity and the lone mention keeps the top slot. This isolates trust as
    // the cause of the reorder in the test above.
    fake.tables["knowledge_nodes"] = [
      {
        id: CONCEPT_VERIFIED,
        verification_status: "unverified",
        confidence: 0.3,
        meta: { sourceCount: 1, sources: [{ videoId: VID_VERIFIED, timestamps: [12] }] },
      },
      {
        id: CONCEPT_LONE,
        verification_status: "unverified",
        confidence: 0.3,
        meta: { sourceCount: 1, sources: [{ videoId: VID_LONE, timestamps: [102] }] },
      },
    ];

    const res = await request(app).post("/api/search").send({ query: "What torch angle should I use?" });

    expect(res.status).toBe(200);
    const results = res.body.results as SearchResult[];
    expect(results).toHaveLength(2);
    expect(results[0]!.videoId).toBe(VID_LONE);
    expect(results[1]!.videoId).toBe(VID_VERIFIED);
  });

  it("drops a result covered only by a reviewer-rejected concept, end-to-end", async () => {
    // The lone mention's concept has been rejected by a reviewer; its segment must
    // never be surfaced even though it had the highest raw similarity.
    seedSegments();
    seedEdges();
    fake.tables["knowledge_nodes"] = [
      {
        id: CONCEPT_VERIFIED,
        verification_status: "verified",
        confidence: 0.9,
        meta: {
          sourceCount: 3,
          sources: [
            { videoId: VID_VERIFIED, timestamps: [12] },
            { videoId: VID_CORROB_2, timestamps: [30] },
            { videoId: VID_CORROB_3, timestamps: [45] },
          ],
        },
      },
      {
        id: CONCEPT_LONE,
        verification_status: "rejected",
        confidence: 0.3,
        meta: { sourceCount: 1, sources: [{ videoId: VID_LONE, timestamps: [102] }] },
      },
    ];

    const res = await request(app).post("/api/search").send({ query: "What torch angle should I use?" });

    expect(res.status).toBe(200);
    const results = res.body.results as SearchResult[];
    expect(results).toHaveLength(1);
    expect(results[0]!.videoId).toBe(VID_VERIFIED);
    expect(results.some((r) => r.videoId === VID_LONE)).toBe(false);
  });
});
