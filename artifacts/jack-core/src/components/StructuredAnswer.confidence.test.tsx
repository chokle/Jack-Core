// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import type { Citation } from "@workspace/api-client-react";
import { deriveConfidence, TONE_CLASSES } from "./StructuredAnswer";

/**
 * Coverage for the confidence pill shown at the top of every Jack answer,
 * driven by `deriveConfidence()`. Task #136 locked the client `TrustBadges`
 * component to the server trust contract, but this *other* trust surface in the
 * same answer — the "High confidence / Medium confidence / General knowledge"
 * pill — has its own thresholds with no test. If someone changes a threshold or
 * drops the `usedInternalKnowledge` branch, Jack could label a well-corroborated
 * answer "General knowledge" (or vice-versa), quietly misrepresenting how
 * trustworthy the answer is. These cases pin the exact label + tone across the
 * (citation-count x usedInternalKnowledge) matrix so a shifted threshold fails
 * loudly.
 *
 * Thresholds asserted (mirroring `deriveConfidence`):
 *   >= 2 citations                       -> "High confidence"    (tone "high")
 *   exactly 1 citation                   -> "Medium confidence"  (tone "medium")
 *   0 citations but usedInternalKnowledge -> "Medium confidence"  (tone "medium")
 *   otherwise                            -> "General knowledge"  (tone "low")
 */

// deriveConfidence only reads `citations.length`, so a length-n array of
// placeholder citations is sufficient to exercise every threshold.
function citations(n: number): Citation[] {
  return Array.from({ length: n }, () => ({}) as unknown as Citation);
}

describe("deriveConfidence", () => {
  it("labels >= 2 citations as High confidence regardless of internal knowledge", () => {
    for (const n of [2, 3, 5]) {
      for (const used of [undefined, false, true]) {
        expect(deriveConfidence(citations(n), used)).toEqual({
          label: "High confidence",
          tone: "high",
        });
      }
    }
  });

  it("labels exactly 1 citation as Medium confidence regardless of internal knowledge", () => {
    for (const used of [undefined, false, true]) {
      expect(deriveConfidence(citations(1), used)).toEqual({
        label: "Medium confidence",
        tone: "medium",
      });
    }
  });

  it("labels 0 citations + usedInternalKnowledge as Medium confidence", () => {
    expect(deriveConfidence(citations(0), true)).toEqual({
      label: "Medium confidence",
      tone: "medium",
    });
  });

  it("labels 0 citations without internal knowledge as General knowledge", () => {
    for (const used of [undefined, false]) {
      expect(deriveConfidence(citations(0), used)).toEqual({
        label: "General knowledge",
        tone: "low",
      });
    }
  });

  // The full matrix, asserting the exact label + tone for each cell so any
  // single threshold or branch change is caught.
  const cases: Array<{ n: number; used?: boolean; label: string; tone: string }> = [
    { n: 0, used: undefined, label: "General knowledge", tone: "low" },
    { n: 0, used: false, label: "General knowledge", tone: "low" },
    { n: 0, used: true, label: "Medium confidence", tone: "medium" },
    { n: 1, used: undefined, label: "Medium confidence", tone: "medium" },
    { n: 1, used: false, label: "Medium confidence", tone: "medium" },
    { n: 1, used: true, label: "Medium confidence", tone: "medium" },
    { n: 2, used: undefined, label: "High confidence", tone: "high" },
    { n: 2, used: false, label: "High confidence", tone: "high" },
    { n: 2, used: true, label: "High confidence", tone: "high" },
  ];

  for (const { n, used, label, tone } of cases) {
    it(`maps ${n} citations + used=${String(used)} to "${label}" (tone "${tone}")`, () => {
      const result = deriveConfidence(citations(n), used);
      expect(result).toEqual({ label, tone });
      // The tone must resolve to a real class so the pill is actually styled.
      expect(TONE_CLASSES[result.tone]).toBeTruthy();
    });
  }
});
