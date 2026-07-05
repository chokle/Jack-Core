/**
 * Guard tests for trust-driven reranking of retrieval results. Concept trust —
 * reviewer decisions (verified/rejected) plus corroboration (derived confidence
 * across multiple source videos) — must steer what semantic search and Ask Jack
 * surface: verified concepts' source segments are boosted, rejected concepts'
 * source segments are suppressed, well-corroborated concepts' segments get an
 * additional bump, verified wins ties, and unrelated segments are left untouched.
 * These tests exist so a future change to the retrieval path can't silently stop
 * honoring reviewer decisions or corroboration.
 */
import { describe, it, expect } from "vitest";
import {
  buildCoverageFromNodes,
  segmentVerification,
  segmentTrust,
  rerankByVerification,
  corroborationBoost,
  VERIFIED_SCORE_BOOST,
  CORROBORATION_MAX_BOOST,
  type ConceptCoverage,
} from "../verification-rerank.js";

const VID_A = "aaaaaaaa-0000-0000-0000-000000000001";
const VID_B = "bbbbbbbb-0000-0000-0000-000000000002";

function node(
  status: string,
  sources: Array<{ videoId: string; timestamps: number[] }>,
  confidence = 0.5,
) {
  return { verification_status: status, confidence, meta: { sources, sourceCount: sources.length } };
}

/** A single-source (no-corroboration) coverage entry with the given status. */
function cov(status: ConceptCoverage["status"], timestamps: number[], videoId = VID_A): ConceptCoverage {
  return { videoId, timestamps, status, confidence: 0.5, sourceCount: 1 };
}

describe("buildCoverageFromNodes", () => {
  it("keeps verified/rejected/unverified nodes whose sources touch the wanted videos", () => {
    const rows = [
      node("verified", [{ videoId: VID_A, timestamps: [10] }]),
      node("rejected", [{ videoId: VID_B, timestamps: [20] }]),
      node("unverified", [{ videoId: VID_A, timestamps: [30] }]),
      node("mentor_supplied", [{ videoId: VID_A, timestamps: [40] }]),
      node("verified", [{ videoId: "other-video", timestamps: [50] }]),
    ];
    const coverage = buildCoverageFromNodes(rows, [VID_A, VID_B]);
    expect(coverage.map((c) => ({ videoId: c.videoId, timestamps: c.timestamps, status: c.status }))).toEqual([
      { videoId: VID_A, timestamps: [10], status: "verified" },
      { videoId: VID_B, timestamps: [20], status: "rejected" },
      { videoId: VID_A, timestamps: [30], status: "unverified" },
      // any non-verified/rejected status collapses to "unverified"
      { videoId: VID_A, timestamps: [40], status: "unverified" },
    ]);
  });

  it("carries derived confidence and source count from the node", () => {
    const rows = [
      {
        verification_status: "verified",
        confidence: 0.87,
        meta: {
          sources: [
            { videoId: VID_A, timestamps: [10] },
            { videoId: VID_B, timestamps: [20] },
          ],
          sourceCount: 2,
        },
      },
    ];
    const coverage = buildCoverageFromNodes(rows, [VID_A, VID_B]);
    expect(coverage).toHaveLength(2);
    expect(coverage.every((c) => c.confidence === 0.87 && c.sourceCount === 2)).toBe(true);
  });

  it("falls back to sources.length when sourceCount is absent, and clamps confidence", () => {
    const rows = [
      {
        verification_status: "unverified",
        confidence: 5,
        meta: { sources: [{ videoId: VID_A, timestamps: [10] }] },
      },
    ];
    const coverage = buildCoverageFromNodes(rows, [VID_A]);
    expect(coverage[0]?.sourceCount).toBe(1);
    expect(coverage[0]?.confidence).toBe(1);
  });

  it("ignores sources with no timestamps (can't be tied to a segment)", () => {
    const rows = [node("verified", [{ videoId: VID_A, timestamps: [] }])];
    expect(buildCoverageFromNodes(rows, [VID_A])).toEqual([]);
  });

  it("tolerates malformed rows/meta without throwing", () => {
    const rows = [
      { verification_status: "verified" },
      { verification_status: "verified", meta: { sources: "nope" } },
      { verification_status: "verified", meta: { sources: [null, { timestamps: [1] }] } },
      {},
    ];
    expect(buildCoverageFromNodes(rows as never, [VID_A])).toEqual([]);
  });
});

describe("corroborationBoost", () => {
  it("is zero for a single source (one mention is not corroboration)", () => {
    expect(corroborationBoost(1, 1)).toBe(0);
    expect(corroborationBoost(0.9, 0)).toBe(0);
  });

  it("scales with confidence and saturates at the full-source count", () => {
    // 3 sources at full confidence saturates to the max boost.
    expect(corroborationBoost(1, 3)).toBeCloseTo(CORROBORATION_MAX_BOOST);
    expect(corroborationBoost(1, 10)).toBeCloseTo(CORROBORATION_MAX_BOOST);
    // 2 sources is halfway up the ramp (full at 3), scaled by confidence.
    expect(corroborationBoost(1, 2)).toBeCloseTo(CORROBORATION_MAX_BOOST / 2);
    expect(corroborationBoost(0.5, 3)).toBeCloseTo(CORROBORATION_MAX_BOOST * 0.5);
  });
});

describe("segmentVerification", () => {
  it("marks a segment verified when a verified concept timestamp is inside its window", () => {
    expect(
      segmentVerification({ videoId: VID_A, startTime: 10, endTime: 15 }, [cov("verified", [12])]),
    ).toBe("verified");
  });

  it("marks a segment rejected when only a rejected concept covers it", () => {
    expect(
      segmentVerification({ videoId: VID_A, startTime: 10, endTime: 15 }, [cov("rejected", [12])]),
    ).toBe("rejected");
  });

  it("lets verified win over rejected for the same window", () => {
    expect(
      segmentVerification({ videoId: VID_A, startTime: 10, endTime: 15 }, [
        cov("rejected", [12]),
        cov("verified", [12]),
      ]),
    ).toBe("verified");
  });

  it("treats an unverified-only covering concept as neutral", () => {
    expect(
      segmentVerification({ videoId: VID_A, startTime: 10, endTime: 15 }, [cov("unverified", [12])]),
    ).toBe("neutral");
  });

  it("lets a reviewer rejection win over an unverified corroboration", () => {
    expect(
      segmentVerification({ videoId: VID_A, startTime: 10, endTime: 15 }, [
        cov("unverified", [12]),
        cov("rejected", [12]),
      ]),
    ).toBe("rejected");
  });

  it("is neutral when the concept belongs to a different video", () => {
    expect(
      segmentVerification({ videoId: VID_B, startTime: 10, endTime: 15 }, [cov("verified", [12])]),
    ).toBe("neutral");
  });

  it("is neutral when no concept timestamp falls in the window", () => {
    expect(
      segmentVerification({ videoId: VID_A, startTime: 100, endTime: 105 }, [cov("verified", [12])]),
    ).toBe("neutral");
  });

  it("applies a small tolerance around the window boundaries", () => {
    // 16.5 is outside [10,15] but within the padded window.
    expect(
      segmentVerification({ videoId: VID_A, startTime: 10, endTime: 15 }, [cov("verified", [16.5])]),
    ).toBe("verified");
  });
});

describe("segmentTrust", () => {
  it("reports the covering concept's confidence and source count", () => {
    const coverage: ConceptCoverage[] = [
      { videoId: VID_A, timestamps: [12], status: "verified", confidence: 0.8, sourceCount: 4 },
    ];
    const trust = segmentTrust({ videoId: VID_A, startTime: 10, endTime: 15 }, coverage);
    expect(trust.verification).toBe("verified");
    expect(trust.confidence).toBe(0.8);
    expect(trust.sourceCount).toBe(4);
    // corroboration bump saturates on source count (4 ≥ 3) but scales by confidence.
    expect(trust.boost).toBeCloseTo(VERIFIED_SCORE_BOOST + CORROBORATION_MAX_BOOST * 0.8);
  });

  it("picks the best-corroborated verified concept when several cover the window", () => {
    const coverage: ConceptCoverage[] = [
      { videoId: VID_A, timestamps: [12], status: "verified", confidence: 0.5, sourceCount: 1 },
      { videoId: VID_A, timestamps: [13], status: "verified", confidence: 1, sourceCount: 3 },
    ];
    const trust = segmentTrust({ videoId: VID_A, startTime: 10, endTime: 15 }, coverage);
    expect(trust.sourceCount).toBe(3);
    expect(trust.boost).toBeCloseTo(VERIFIED_SCORE_BOOST + CORROBORATION_MAX_BOOST);
  });

  it("gives an unverified-only segment a corroboration-only boost", () => {
    const coverage: ConceptCoverage[] = [
      { videoId: VID_A, timestamps: [12], status: "unverified", confidence: 1, sourceCount: 3 },
    ];
    const trust = segmentTrust({ videoId: VID_A, startTime: 10, endTime: 15 }, coverage);
    expect(trust.verification).toBe("neutral");
    expect(trust.boost).toBeCloseTo(CORROBORATION_MAX_BOOST);
  });
});

describe("rerankByVerification", () => {
  interface Seg {
    id: string;
    videoId: string;
    startTime: number;
    endTime: number;
    score: number;
  }
  const accessor = (s: Seg) => s;

  function seg(id: string, videoId: string, startTime: number, score: number): Seg {
    return { id, videoId, startTime, endTime: startTime + 5, score };
  }

  it("boosts verified segments and re-sorts them above higher-raw-score neutrals", () => {
    const items = [
      seg("neutral", VID_B, 0, 0.7), // no coverage
      seg("verified", VID_A, 10, 0.6), // covered by verified concept
    ];
    const out = rerankByVerification(items, accessor, [cov("verified", [12])]);
    expect(out.map((r) => r.item.id)).toEqual(["verified", "neutral"]);
    expect(out[0]?.score).toBeCloseTo(0.6 + VERIFIED_SCORE_BOOST);
    expect(out[0]?.verification).toBe("verified");
    expect(out[1]?.score).toBe(0.7);
  });

  it("lifts a well-corroborated unverified segment above a higher-raw-score lone mention", () => {
    const items = [
      seg("lone", VID_B, 0, 0.62), // unreviewed, single source
      seg("corroborated", VID_A, 10, 0.6), // unreviewed, confirmed across 3 videos
    ];
    const coverage: ConceptCoverage[] = [
      { videoId: VID_A, timestamps: [12], status: "unverified", confidence: 1, sourceCount: 3 },
    ];
    const out = rerankByVerification(items, accessor, coverage);
    expect(out.map((r) => r.item.id)).toEqual(["corroborated", "lone"]);
    expect(out[0]?.score).toBeCloseTo(0.6 + CORROBORATION_MAX_BOOST);
    expect(out[0]?.sourceCount).toBe(3);
  });

  it("drops segments covered only by a rejected concept", () => {
    const items = [seg("keep", VID_A, 0, 0.9), seg("drop", VID_A, 100, 0.8)];
    const out = rerankByVerification(items, accessor, [cov("rejected", [102])]);
    expect(out.map((r) => r.item.id)).toEqual(["keep"]);
  });

  it("keeps a segment that is both verified and rejected (verified wins) and boosts it", () => {
    const items = [seg("mixed", VID_A, 10, 0.5)];
    const coverage: ConceptCoverage[] = [cov("rejected", [12]), cov("verified", [13])];
    const out = rerankByVerification(items, accessor, coverage);
    expect(out).toHaveLength(1);
    expect(out[0]?.verification).toBe("verified");
    expect(out[0]?.score).toBeCloseTo(0.5 + VERIFIED_SCORE_BOOST);
  });

  it("caps a boosted score at 1", () => {
    const items = [seg("high", VID_A, 10, 0.95)];
    const out = rerankByVerification(items, accessor, [cov("verified", [12])]);
    expect(out[0]?.score).toBe(1);
  });

  it("keeps everything and sorts by raw score when there is no coverage", () => {
    const items = [seg("a", VID_A, 0, 0.4), seg("b", VID_B, 0, 0.9)];
    const out = rerankByVerification(items, accessor, []);
    expect(out.map((r) => r.item.id)).toEqual(["b", "a"]);
    expect(out.every((r) => r.verification === "neutral")).toBe(true);
  });

  it("preserves input order for equal adjusted scores (stable ties)", () => {
    const items = [seg("first", VID_A, 0, 0.5), seg("second", VID_B, 0, 0.5)];
    const out = rerankByVerification(items, accessor, []);
    expect(out.map((r) => r.item.id)).toEqual(["first", "second"]);
  });
});
