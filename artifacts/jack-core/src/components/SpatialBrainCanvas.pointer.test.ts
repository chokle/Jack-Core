import { describe, expect, it } from "vitest";
import {
  graphHitPriority,
  graphNodeHitRadius,
  graphTapSlop,
  resolveGraphTapTarget,
} from "./SpatialBrainCanvas";

describe("SpatialBrainCanvas pointer selection", () => {
  it("gives small touch nodes a 44px target", () => {
    expect(graphNodeHitRadius(4, "touch")).toBe(22);
    expect(graphNodeHitRadius(4, "pen")).toBe(18);
    expect(graphNodeHitRadius(4, "mouse")).toBe(12);
  });

  it("preserves the rendered radius for already-large nodes", () => {
    expect(graphNodeHitRadius(30, "touch")).toBe(38);
  });

  it("accepts ordinary touch jitter without treating it as orbit", () => {
    expect(graphTapSlop("touch")).toBe(14);
    expect(graphTapSlop("pen")).toBe(10);
    expect(graphTapSlop("mouse")).toBe(6);
  });

  it("keeps the pointer-down node stable while animated children move", () => {
    expect(resolveGraphTapTarget("concept:1", null, true)).toBe("concept:1");
    expect(resolveGraphTapTarget("concept:1", "concept:2", true)).toBe(
      "concept:1",
    );
  });

  it("falls back to the release hit when the pressed node disappeared", () => {
    expect(resolveGraphTapTarget("concept:1", "concept:2", false)).toBe(
      "concept:2",
    );
  });

  it("prefers a direct rendered hit over an overlapping enlarged target", () => {
    const directFarther = graphHitPriority(3, 4, 100, "touch");
    const enlargedNearer = graphHitPriority(12, 4, -100, "touch");
    expect(directFarther).not.toBeNull();
    expect(enlargedNearer).not.toBeNull();
    expect(directFarther![0]).toBeLessThan(enlargedNearer![0]);
    expect(graphHitPriority(23, 4, -100, "touch")).toBeNull();
  });
});
