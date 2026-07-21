import { describe, expect, it } from "vitest";
import {
  buildPulseTopology,
  MemoryGraphPulseController,
  pulseSegment,
  type PulseTopology,
} from "./memory-graph-pulse";

describe("buildPulseTopology", () => {
  it("routes each populated trade hub into its current populated sub-nodes", () => {
    const topology = buildPulseTopology(
      "core",
      ["trade:welder", "trade:empty"],
      [
        { a: "core", b: "trade:welder" },
        { a: "core", b: "trade:empty" },
        { a: "trade:welder", b: "procedure:cutting" },
        { a: "trade:welder", b: "concept:heat" },
        { a: "trade:welder", b: "placeholder:missing" },
      ],
      new Set([
        "core",
        "trade:welder",
        "procedure:cutting",
        "concept:heat",
      ]),
    );

    expect(topology).toEqual({
      coreId: "core",
      hubIds: ["trade:welder"],
      membersByHub: {
        "trade:welder": ["procedure:cutting", "concept:heat"],
      },
    });
  });
});

const TOPOLOGY: PulseTopology = {
  coreId: "core",
  hubIds: ["hubA", "hubB"],
  membersByHub: {
    hubA: ["a1", "a2", "a3"],
    hubB: ["b1"],
  },
};

/** Fast, deterministic controller: 1s intervals, 1s travel, no stagger. */
function makeController(random: () => number = () => 0) {
  const c = new MemoryGraphPulseController({
    minIntervalSec: 1,
    maxIntervalSec: 1,
    firstDelaySec: 1,
    primaryTravelSec: 1,
    secondaryTravelSec: 1,
    fanoutStaggerSec: 0,
    maxStepSec: 100, // don't clamp dt in tests — we jump time explicitly
    random,
  });
  c.setTopology(TOPOLOGY);
  return c;
}

describe("MemoryGraphPulseController", () => {
  it("stays quiet before the first interval elapses", () => {
    const c = makeController();
    c.update(0);
    c.update(500);
    expect(c.hasActivity()).toBe(false);
    expect(c.getPulses()).toHaveLength(0);
  });

  it("fires one primary pulse from the core to a random hub", () => {
    const c = makeController(() => 0); // hub index 0 → hubA
    c.update(0);
    c.update(1000); // interval reached
    const pulses = c.getPulses();
    expect(pulses).toHaveLength(1);
    expect(pulses[0]).toMatchObject({
      fromId: "core",
      toId: "hubA",
      kind: "primary",
    });
    expect(pulses[0].t).toBeCloseTo(0, 5);
  });

  it("advances the primary along the edge over time", () => {
    const c = makeController();
    c.update(0);
    c.update(1000);
    c.update(1500); // +0.5s at 1s travel → halfway
    expect(c.getPulses()[0].t).toBeCloseTo(0.5, 5);
  });

  it("fans out one secondary per branch when the primary arrives", () => {
    const c = makeController(() => 0); // hubA (members a1,a2,a3)
    c.update(0);
    c.update(1000); // primary starts
    c.update(2000); // primary arrives → fan out
    const pulses = c.getPulses();
    expect(pulses).toHaveLength(3);
    expect(pulses.every((p) => p.kind === "secondary")).toBe(true);
    expect(pulses.map((p) => p.toId).sort()).toEqual(["a1", "a2", "a3"]);
    expect(pulses.every((p) => p.fromId === "hubA")).toBe(true);
  });

  it("clears secondaries once they finish, then falls quiet", () => {
    const c = makeController(() => 0);
    c.update(0);
    c.update(1000);
    c.update(2000); // fan out
    c.update(2999); // secondaries at ~0.999, still live
    expect(c.hasActivity()).toBe(true);
    // A fresh controller with a longer interval proves the quiet gap: burst
    // ends well before the next event is due, so nothing is active in between.
    const q = new MemoryGraphPulseController({
      minIntervalSec: 8,
      maxIntervalSec: 8,
      firstDelaySec: 0,
      primaryTravelSec: 1,
      secondaryTravelSec: 1,
      fanoutStaggerSec: 0,
      maxStepSec: 100,
      random: () => 0,
    });
    q.setTopology(TOPOLOGY);
    q.update(0); // schedules first event at t=0
    q.update(0); // fire primary
    q.update(1000); // primary arrives → fan out
    q.update(2000); // secondaries done
    q.update(5000); // mid-gap: quiet, next event not until ~8s
    expect(q.hasActivity()).toBe(false);
    expect(q.getPulses()).toHaveLength(0);
  });

  it("caps the fan-out at maxFanout with distinct in-cluster members", () => {
    const many = Array.from({ length: 100 }, (_, i) => `m${i}`);
    const c = new MemoryGraphPulseController({
      minIntervalSec: 1,
      maxIntervalSec: 1,
      firstDelaySec: 1,
      primaryTravelSec: 1,
      secondaryTravelSec: 1,
      fanoutStaggerSec: 0,
      maxFanout: 40,
      maxStepSec: 100,
      random: () => 0,
    });
    c.setTopology({ coreId: "core", hubIds: ["big"], membersByHub: { big: many } });
    c.update(0);
    c.update(1000);
    c.update(2000);
    const pulses = c.getPulses();
    expect(pulses).toHaveLength(40);
    const ids = new Set(pulses.map((p) => p.toId));
    expect(ids.size).toBe(40); // all distinct
    expect([...ids].every((id) => many.includes(id))).toBe(true);
  });

  it("hides staggered secondaries until their delay elapses", () => {
    const c = new MemoryGraphPulseController({
      minIntervalSec: 1,
      maxIntervalSec: 1,
      firstDelaySec: 1,
      primaryTravelSec: 1,
      secondaryTravelSec: 1,
      fanoutStaggerSec: 0.5,
      maxStepSec: 100,
      random: () => 1, // hub index wraps to 0; every stagger delay = 0.5s
    });
    c.setTopology(TOPOLOGY);
    c.update(0);
    c.update(1000);
    c.update(2000); // fan out, but all secondaries delayed 0.5s
    expect(c.hasActivity()).toBe(true);
    expect(c.getPulses()).toHaveLength(0); // not moving yet
    c.update(2600); // +0.6s → delays elapsed
    expect(c.getPulses().length).toBeGreaterThan(0);
  });

  it("never fires when disabled (reduced motion / locked)", () => {
    const c = makeController();
    c.setEnabled(false);
    for (let t = 0; t <= 5000; t += 250) c.update(t);
    expect(c.hasActivity()).toBe(false);
    expect(c.getPulses()).toHaveLength(0);
  });

  it("does not throw or fire when there are no hubs", () => {
    const c = makeController();
    c.setTopology({ coreId: "core", hubIds: [], membersByHub: {} });
    for (let t = 0; t <= 5000; t += 250) c.update(t);
    expect(c.hasActivity()).toBe(false);
  });

  it("defaults to green and reflects the set state color", () => {
    const c = makeController();
    expect(c.getColor()).toEqual([110, 231, 183]);
    c.setColor([167, 139, 250]);
    expect(c.getColor()).toEqual([167, 139, 250]);
  });
});

describe("pulseSegment (degenerate-geometry guard)", () => {
  it("returns a short comet trail behind the head for a normal pulse", () => {
    // Horizontal edge (0,0) → (100,0), halfway, 0.16 trail.
    const seg = pulseSegment(0, 0, 100, 0, 0.5, 0.16);
    expect(seg).not.toBeNull();
    expect(seg!.hx).toBeCloseTo(50, 5);
    expect(seg!.hy).toBeCloseTo(0, 5);
    // Tail sits 0.16 of the edge behind the head.
    expect(seg!.tx).toBeCloseTo(34, 5);
    expect(seg!.ty).toBeCloseTo(0, 5);
    // The trail spans only a small fraction of the edge, never the whole edge.
    expect(seg!.hx - seg!.tx).toBeCloseTo(16, 5);
  });

  it("draws nothing at t=0 where head and tail coincide", () => {
    expect(pulseSegment(0, 0, 100, 0, 0, 0.16)).toBeNull();
  });

  it("draws nothing on a zero-length edge (overlapping nodes)", () => {
    // Both endpoints at the same point — the whole edge is degenerate.
    expect(pulseSegment(42, 42, 42, 42, 0.5, 0.16)).toBeNull();
  });

  it("draws nothing when any endpoint is non-finite", () => {
    expect(pulseSegment(NaN, 0, 100, 0, 0.5, 0.16)).toBeNull();
    expect(pulseSegment(0, 0, Infinity, 0, 0.5, 0.16)).toBeNull();
    expect(pulseSegment(0, -Infinity, 100, 0, 0.5, 0.16)).toBeNull();
    expect(pulseSegment(0, 0, 100, NaN, 0.5, 0.16)).toBeNull();
  });

  it("keeps the trail short and glued to a vertical (top-hub) edge", () => {
    // Core (0,0) directly below the top hub (0,-200): the pulse must read as a
    // short travelling comet, not a persistent full-height vertical line.
    const seg = pulseSegment(0, 0, 0, -200, 0.5, 0.16);
    expect(seg).not.toBeNull();
    expect(seg!.hx).toBeCloseTo(0, 5);
    expect(seg!.hy).toBeCloseTo(-100, 5);
    // Trail length is 0.16 * 200 = 32 world units — a small fraction of 200.
    expect(Math.abs(seg!.hy - seg!.ty)).toBeCloseTo(32, 5);
    expect(seg!.tx).toBeCloseTo(0, 5);
  });

  it("clamps head progress to [0,1] so an overshot pulse never runs past the edge", () => {
    const seg = pulseSegment(0, 0, 100, 0, 1.4, 0.16);
    expect(seg).not.toBeNull();
    expect(seg!.hx).toBeCloseTo(100, 5);
  });
});
