/**
 * Lock the trust BADGE (on a citation) to the trust PROSE (that Jack may write
 * into its answer). Both derive from the same reranker result, but nothing in the
 * type system keeps them in step: the citation gets `verified`/`sourceCount`
 * fields (badged by the client) while the prose language comes from
 * `describeTrust()` (injected into the model's context). A future change to
 * `describeTrust()`'s gating, or to how the route populates citations, could
 * silently make the badge and the answer text disagree — a "Mentor-verified"
 * badge on a citation whose prose never claims verification, or vice versa.
 * That erodes exactly the trust these badges are meant to build.
 *
 * Three guards:
 *   1. Route: for a reranked VIDEO segment, the built citation carries
 *      `verified === (verification === "verified")` and the SAME `sourceCount`
 *      the reranker produced (computed independently here, then compared).
 *   2. Route: a KNOWLEDGE citation never carries `verified`/`sourceCount`.
 *   3. Contract: the citation's `verified`/`sourceCount` gating matches
 *      `describeTrust()`'s thresholds across the full (verification × sourceCount)
 *      matrix (verified → "mentor-verified"; sourceCount >= 2 → "confirmed across
 *      N videos"), so the badge and the prose can never drift apart.
 *
 * Supabase and OpenAI are mocked with the shared in-memory fakes, so no network
 * or embedding cost is incurred; retrieval scores are pinned via each seeded
 * segment's `similarity`.
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
    chatCompletion: vi.fn(async () => ({
      choices: [{ message: { content: "Answer text is irrelevant to this test." } }],
    })),
    MODELS: m.MODELS,
    openai: m.openai,
  };
});

import chatRouter, { describeTrust } from "../chat.js";
import { fake, resetMocks } from "../../lib/__tests__/mocks.js";
import { buildCoverageFromNodes, rerankByVerification } from "../../lib/verification-rerank.js";

const VID_VERIFIED = "11111111-1111-1111-1111-111111111111";
const VID_CORROB_2 = "22222222-2222-2222-2222-222222222222";
const VID_CORROB_3 = "33333333-3333-3333-3333-333333333333";
const VID_LONE = "99999999-9999-9999-9999-999999999999";

const CONCEPT_VERIFIED = "k:concept:torch-angle";
const CONCEPT_LONE = "k:concept:torch-lone";

/**
 * Two competing retrieved segments: a mentor-verified concept confirmed across
 * three videos, and a lone unreviewed mention with a (deliberately higher) raw
 * similarity. This is the exact shape the route retrieves; we reuse it to compute
 * the reranker's output independently and compare it to the citations the route
 * returns.
 */
const RAW_SEGMENTS = [
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

const NODES = [
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

function seedGraph(): void {
  fake.tables["transcript_segments"] = RAW_SEGMENTS.map((s) => ({ ...s }));
  fake.tables["knowledge_edges"] = [
    { source_id: `video:${VID_VERIFIED}`, target_id: CONCEPT_VERIFIED, kind: "knowledge" },
    { source_id: `video:${VID_CORROB_2}`, target_id: CONCEPT_VERIFIED, kind: "knowledge" },
    { source_id: `video:${VID_CORROB_3}`, target_id: CONCEPT_VERIFIED, kind: "knowledge" },
    { source_id: `video:${VID_LONE}`, target_id: CONCEPT_LONE, kind: "knowledge" },
  ];
  fake.tables["knowledge_nodes"] = NODES.map((n) => ({ ...n }));
}

/**
 * Reproduce, outside the route, what the reranker produces for the retrieved
 * segments — the SAME `verification`/`sourceCount` the route builds its citations
 * from. If the route's citation-build loop drifts from the reranker, the
 * per-video comparison below fails.
 */
function expectedTrustByVideo(): Map<string, { verified: boolean; sourceCount: number }> {
  const coverage = buildCoverageFromNodes(NODES, [VID_VERIFIED, VID_LONE]);
  const ranked = rerankByVerification(
    RAW_SEGMENTS,
    (s) => ({
      videoId: s.video_id,
      startTime: s.start_time,
      endTime: s.end_time,
      score: s.similarity,
    }),
    coverage,
  );
  const map = new Map<string, { verified: boolean; sourceCount: number }>();
  for (const r of ranked) {
    map.set(r.item.video_id, {
      verified: r.verification === "verified",
      sourceCount: r.sourceCount,
    });
  }
  return map;
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
  app.use("/api", chatRouter);
  return app;
}

const app = makeApp();

interface Citation {
  videoId: string;
  sourceType: "video" | "knowledge";
  verified?: boolean;
  sourceCount?: number;
  entryId?: string;
}

beforeEach(() => {
  resetMocks();
});

describe("chat citations — badge trust matches the reranker", () => {
  it("gives each VIDEO citation verified === (verification === 'verified') and the reranker's sourceCount", async () => {
    seedGraph();

    const res = await request(app).post("/api/chat").send({ message: "What torch angle should I use?" });
    expect(res.status).toBe(200);

    const expected = expectedTrustByVideo();
    const videoCitations = (res.body.citations as Citation[]).filter((c) => c.sourceType === "video");
    expect(videoCitations.length).toBe(expected.size);

    for (const c of videoCitations) {
      const exp = expected.get(c.videoId);
      expect(exp, `no reranker result for ${c.videoId}`).toBeDefined();
      // The badge (verified) is exactly the reranker's verified verdict...
      expect(c.verified).toBe(exp!.verified);
      // ...and the corroboration count is exactly what the reranker produced.
      expect(c.sourceCount).toBe(exp!.sourceCount);
    }

    // Sanity: the seeded scenario actually exercises a verified, multi-video
    // citation (otherwise the assertion above could pass vacuously).
    const verifiedCitation = videoCitations.find((c) => c.videoId === VID_VERIFIED);
    expect(verifiedCitation).toMatchObject({ verified: true, sourceCount: 3 });
  });

  it("never puts verified/sourceCount on a KNOWLEDGE citation", async () => {
    seedGraph();
    // A non-video Knowledge Entry: it has no trust signal and must never be
    // badged, so the route must omit verified/sourceCount entirely.
    fake.tables["knowledge_entries"] = [
      {
        id: "entry-1",
        title: "Field note: torch angle",
        description: "Keep the torch at a consistent angle.",
        body: "",
        images: [],
      },
    ];

    const res = await request(app).post("/api/chat").send({ message: "torch angle" });
    expect(res.status).toBe(200);

    const knowledgeCitations = (res.body.citations as Citation[]).filter(
      (c) => c.sourceType === "knowledge",
    );
    expect(knowledgeCitations.length).toBeGreaterThan(0);
    for (const c of knowledgeCitations) {
      expect("verified" in c).toBe(false);
      expect("sourceCount" in c).toBe(false);
      expect(c.entryId).toBe("entry-1");
    }
  });
});

describe("describeTrust — prose gating matches the badge gating", () => {
  const verifications = ["verified", "rejected", "neutral"] as const;
  const sourceCounts = [0, 1, 2, 3, 7];

  it("emits 'mentor-verified' exactly when the citation would badge verified", () => {
    for (const verification of verifications) {
      for (const sourceCount of sourceCounts) {
        // The route sets citation.verified = (verification === "verified").
        const badgeVerified = verification === "verified";
        const prose = describeTrust(verification, sourceCount);
        expect(prose.includes("mentor-verified")).toBe(badgeVerified);
      }
    }
  });

  it("emits 'confirmed across N videos' exactly when sourceCount >= 2 (the badge threshold)", () => {
    for (const verification of verifications) {
      for (const sourceCount of sourceCounts) {
        const prose = describeTrust(verification, sourceCount);
        const hasCorroborationProse = /confirmed across \d+ videos/.test(prose);
        expect(hasCorroborationProse).toBe(sourceCount >= 2);
        // When present, the prose count is the exact citation sourceCount, so the
        // badge ("N videos") and the answer text can't cite different numbers.
        if (sourceCount >= 2) expect(prose).toContain(`confirmed across ${sourceCount} videos`);
      }
    }
  });

  it("stays silent for a lone, unreviewed mention (no badge, no prose)", () => {
    // The one case the client also leaves unbadged: neutral + single-source.
    expect(describeTrust("neutral", 1)).toBe("");
    expect(describeTrust("neutral", 0)).toBe("");
  });
});
