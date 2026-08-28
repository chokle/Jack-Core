import { describe, expect, it } from "vitest";
import {
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
});
