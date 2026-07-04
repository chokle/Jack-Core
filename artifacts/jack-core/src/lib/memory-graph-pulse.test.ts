import { describe, expect, it } from "vitest";
import {
  MemoryGraphPulseController,
  type PulseTopology,
} from "./memory-graph-pulse";

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
