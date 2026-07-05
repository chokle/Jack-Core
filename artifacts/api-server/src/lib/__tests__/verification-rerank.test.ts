/**
 * Guard tests for verification-driven reranking of retrieval results. Reviewer
 * decisions on distilled concepts (verified/rejected) must steer what semantic
 * search and Ask Jack surface: verified concepts' source segments are boosted,
 * rejected concepts' source segments are suppressed, verified wins ties, and
 * unrelated/unreviewed segments are left untouched. These tests exist so a future
 * change to the retrieval path can't silently stop honoring reviewer decisions.
 */
import { describe, it, expect } from "vitest";
import {
  buildCoverageFromNodes,
  segmentVerification,
  rerankByVerification,
  VERIFIED_SCORE_BOOST,
  type ConceptCoverage,
} from "../verification-rerank.js";

const VID_A = "aaaaaaaa-0000-0000-0000-000000000001";
const VID_B = "bbbbbbbb-0000-0000-0000-000000000002";

function node(status: string, sources: Array<{ videoId: string; timestamps: number[] }>) {
  return { verification_status: status, meta: { sources } };
}

describe("buildCoverageFromNodes", () => {
  it("keeps only verified/rejected nodes whose sources touch the wanted videos", () => {
    const rows = [
      node("verified", [{ videoId: VID_A, timestamps: [10] }]),
      node("rejected", [{ videoId: VID_B, timestamps: [20] }]),
      node("unverified", [{ videoId: VID_A, timestamps: [30] }]),
      node("mentor_supplied", [{ videoId: VID_A, timestamps: [40] }]),
      node("verified", [{ videoId: "other-video", timestamps: [50] }]),
    ];
    const coverage = buildCoverageFromNodes(rows, [VID_A, VID_B]);
    expect(coverage).toEqual([
      { videoId: VID_A, timestamps: [10], status: "verified" },
      { videoId: VID_B, timestamps: [20], status: "rejected" },
    ]);
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

describe("segmentVerification", () => {
  const verified: ConceptCoverage = { videoId: VID_A, timestamps: [12], status: "verified" };
  const rejected: ConceptCoverage = { videoId: VID_A, timestamps: [12], status: "rejected" };

  it("marks a segment verified when a verified concept timestamp is inside its window", () => {
    expect(
      segmentVerification({ videoId: VID_A, startTime: 10, endTime: 15 }, [verified]),
    ).toBe("verified");
  });

  it("marks a segment rejected when only a rejected concept covers it", () => {
    expect(
      segmentVerification({ videoId: VID_A, startTime: 10, endTime: 15 }, [rejected]),
    ).toBe("rejected");
  });

  it("lets verified win over rejected for the same window", () => {
    expect(
      segmentVerification({ videoId: VID_A, startTime: 10, endTime: 15 }, [rejected, verified]),
    ).toBe("verified");
  });

  it("is neutral when the concept belongs to a different video", () => {
    expect(
      segmentVerification({ videoId: VID_B, startTime: 10, endTime: 15 }, [verified]),
    ).toBe("neutral");
  });

  it("is neutral when no concept timestamp falls in the window", () => {
    expect(
      segmentVerification({ videoId: VID_A, startTime: 100, endTime: 105 }, [verified]),
    ).toBe("neutral");
  });

  it("applies a small tolerance around the window boundaries", () => {
    const c: ConceptCoverage = { videoId: VID_A, timestamps: [16.5], status: "verified" };
    // 16.5 is outside [10,15] but within the padded window.
    expect(segmentVerification({ videoId: VID_A, startTime: 10, endTime: 15 }, [c])).toBe(
      "verified",
    );
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
    const coverage: ConceptCoverage[] = [
      { videoId: VID_A, timestamps: [12], status: "verified" },
    ];
    const out = rerankByVerification(items, accessor, coverage);
    expect(out.map((r) => r.item.id)).toEqual(["verified", "neutral"]);
    expect(out[0]?.score).toBeCloseTo(0.6 + VERIFIED_SCORE_BOOST);
    expect(out[0]?.verification).toBe("verified");
    expect(out[1]?.score).toBe(0.7);
  });

  it("drops segments covered only by a rejected concept", () => {
    const items = [
      seg("keep", VID_A, 0, 0.9),
      seg("drop", VID_A, 100, 0.8),
    ];
    const coverage: ConceptCoverage[] = [
      { videoId: VID_A, timestamps: [102], status: "rejected" },
    ];
    const out = rerankByVerification(items, accessor, coverage);
    expect(out.map((r) => r.item.id)).toEqual(["keep"]);
  });

  it("keeps a segment that is both verified and rejected (verified wins) and boosts it", () => {
    const items = [seg("mixed", VID_A, 10, 0.5)];
    const coverage: ConceptCoverage[] = [
      { videoId: VID_A, timestamps: [12], status: "rejected" },
      { videoId: VID_A, timestamps: [13], status: "verified" },
    ];
    const out = rerankByVerification(items, accessor, coverage);
    expect(out).toHaveLength(1);
    expect(out[0]?.verification).toBe("verified");
    expect(out[0]?.score).toBeCloseTo(0.5 + VERIFIED_SCORE_BOOST);
  });

  it("caps a boosted score at 1", () => {
    const items = [seg("high", VID_A, 10, 0.95)];
    const coverage: ConceptCoverage[] = [
      { videoId: VID_A, timestamps: [12], status: "verified" },
    ];
    const out = rerankByVerification(items, accessor, coverage);
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
