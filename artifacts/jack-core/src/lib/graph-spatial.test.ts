import { describe, it, expect } from "vitest";
import {
  MAJOR_TRADES,
  DEFAULT_MAX_HOPS,
  DEFAULT_MAX_VISIBLE,
  PITCH_LIMIT,
  SHELL_RADIUS_1,
  withSeededTrades,
  withKnowledgeCounts,
  topicRadiusWeight,
  computeBrainStats,
  buildAdjacency,
  buildHierarchy,
  buildSpatialLayout,
  buildBranchNavigatorLayout,
  fibonacciSphereDir,
  shellRadius,
  clampPitch,
  rotatePoint,
  projectPoint,
  depthCue,
} from "./graph-spatial";
import { buildSyntheticServerGraph } from "./graph-stress";
import { selectMemoryGraphModel, CORE_ID, type GraphModel } from "./memory-graph";

function baseModel() {
  // A tiny real-shaped model: core + one seeded trade + two videos.
  return selectMemoryGraphModel(
    null,
    [
      { id: "v1", title: "Stick Welding Basics", trade: "Welder", status: "completed" },
      { id: "v2", title: "Panel Wiring", trade: "Electrician", status: "completed" },
    ],
    [
      { code: "W-1", name: "Occupational Skills", trade: "Welder" },
      { code: "E-1", name: "Occupational Skills", trade: "Electrician" },
    ],
  );
}

function branchModel(): GraphModel {
  const model = withSeededTrades(baseModel());
  return {
    ...model,
    nodes: [
      ...model.nodes,
      {
        id: "contributor:welder",
        kind: "contributor",
        label: "Welder Mentor",
        topicId: "topic:Welder",
        color: [120, 220, 255],
        meta: { trade: "Welder", userId: "welder" },
      },
      {
        id: "mentor-memory",
        kind: "concept",
        label: "Watch the puddle",
        topicId: "topic:Welder",
        color: [120, 180, 255],
        meta: { trade: "Welder", confidence: 0.8 },
      },
    ],
    edges: [
      ...model.edges,
      { a: "topic:Welder", b: "contributor:welder", kind: "contributor" },
      { a: "contributor:welder", b: "mentor-memory", kind: "concept" },
    ],
    degree: {
      ...model.degree,
      "topic:Welder": (model.degree["topic:Welder"] ?? 0) + 1,
      "contributor:welder": 2,
      "mentor-memory": 1,
    },
  };
}

describe("branch navigator layout", () => {
  it("shows only Jack, trades, and human contributors in the overview", () => {
    const layout = buildBranchNavigatorLayout(branchModel(), CORE_ID);
    expect(layout.centerId).toBe(CORE_ID);
    expect(layout.visibleIds).toContain("topic:Welder");
    expect(layout.visibleIds).toContain("contributor:welder");
    expect(layout.visibleIds).not.toContain("video:v1");
    expect(layout.visibleIds).not.toContain("mentor-memory");
  });

  it("expands the selected trade and retracts the previous trade branch", () => {
    const model = branchModel();
    const welder = buildBranchNavigatorLayout(model, "topic:Welder");
    const electrician = buildBranchNavigatorLayout(model, "topic:Electrician");
    expect(welder.centerId).toBe("topic:Welder");
    expect(welder.visibleIds).toContain("video:v1");
    expect(welder.visibleIds).toContain("mentor-memory");
    expect(electrician.centerId).toBe("topic:Electrician");
    expect(electrician.visibleIds).toContain("video:v2");
    expect(electrician.visibleIds).not.toContain("video:v1");
    expect(electrician.visibleIds).not.toContain("mentor-memory");
  });

  it("centers a contributor and expands only that contributor's memories", () => {
    const layout = buildBranchNavigatorLayout(branchModel(), "contributor:welder");
    expect(layout.centerId).toBe("contributor:welder");
    expect(layout.visibleIds).toContain("mentor-memory");
    expect(layout.visibleIds).not.toContain("video:v1");
  });

  it("does not allow an atomic memory to become the orbital center", () => {
    const layout = buildBranchNavigatorLayout(branchModel(), "mentor-memory");
    expect(layout.centerId).toBe(CORE_ID);
    expect(layout.visibleIds).not.toContain("mentor-memory");
  });
});

describe("withSeededTrades", () => {
  it("adds every major trade hub exactly once and collapses onto existing ones", () => {
    const model = baseModel();
    const seeded = withSeededTrades(model);
    const topicTrades = seeded.topics.map((t) => t.trade);
    for (const trade of MAJOR_TRADES) {
      expect(topicTrades.filter((t) => t === trade)).toHaveLength(1);
    }
    // Welder + Electrician were already real — they must NOT be duplicated.
    const welderHubs = seeded.nodes.filter((n) => n.id === "topic:Welder");
    expect(welderHubs).toHaveLength(1);
    // Every hub is reachable from the core.
    const coreEdges = seeded.edges.filter((e) => e.a === CORE_ID && e.kind === "topic");
    expect(coreEdges.length).toBe(seeded.topics.length);
  });

  it("is idempotent — re-seeding an already-seeded model changes nothing", () => {
    const once = withSeededTrades(baseModel());
    const twice = withSeededTrades(once);
    expect(twice.nodes.length).toBe(once.nodes.length);
    expect(twice.edges.length).toBe(once.edges.length);
    expect(twice.topics.length).toBe(once.topics.length);
  });

  it("re-finalizes so counts and degree stay consistent with the added hubs", () => {
    const seeded = withSeededTrades(baseModel());
    expect(seeded.counts.topics).toBe(seeded.topics.length);
    expect(seeded.counts.nodes).toBe(seeded.nodes.length);
    // The core connects to every hub, so its degree equals the topic count.
    expect(seeded.degree[CORE_ID]).toBe(seeded.topics.length);
  });
});

describe("buildHierarchy", () => {
  const model = withSeededTrades(baseModel());
  const info = buildHierarchy(model);

  it("roots at the core with depth 0 and no parent", () => {
    const core = info.get(CORE_ID)!;
    expect(core.depth).toBe(0);
    expect(core.parentId).toBeNull();
    expect(core.childIds.length).toBe(model.topics.length);
  });

  it("places topic hubs at depth 1 parented to the core", () => {
    const welder = info.get("topic:Welder")!;
    expect(welder.depth).toBe(1);
    expect(welder.parentId).toBe(CORE_ID);
  });

  it("marks freshly-seeded trades as unpopulated virgin clusters", () => {
    // Boilermaker has no videos/knowledge — it is a virgin cluster.
    const boiler = info.get("topic:Boilermaker")!;
    expect(boiler.populated).toBe(false);
    expect(boiler.contentCount).toBe(0);
    // Welder has an ingested video, so it is populated.
    const welder = info.get("topic:Welder")!;
    expect(welder.populated).toBe(true);
  });

  it("keeps parent/child relationships mutually consistent", () => {
    for (const node of info.values()) {
      for (const child of node.childIds) {
        expect(info.get(child)?.parentId).toBe(node.id);
      }
      if (node.parentId) {
        expect(info.get(node.parentId)?.childIds).toContain(node.id);
      }
    }
  });
});

describe("withKnowledgeCounts", () => {
  it("stamps each topic hub with its Knowledge-Entry count", () => {
    const model = withKnowledgeCounts(withSeededTrades(baseModel()), {
      Boilermaker: 3,
      Welder: 2,
    });
    const boiler = model.nodes.find((n) => n.id === "topic:Boilermaker")!;
    expect(boiler.meta.knowledgeObjectCount).toBe(3);
    const welder = model.nodes.find((n) => n.id === "topic:Welder")!;
    expect(welder.meta.knowledgeObjectCount).toBe(2);
  });

  it("lifts a virgin trade to populated once it has written notes", () => {
    const seeded = withSeededTrades(baseModel());
    // Baseline: Boilermaker has no videos/knowledge — it is virgin.
    expect(buildHierarchy(seeded).get("topic:Boilermaker")!.populated).toBe(false);
    // Filing a field note under it should light it up.
    const withNotes = withKnowledgeCounts(seeded, { Boilermaker: 4 });
    const boiler = buildHierarchy(withNotes).get("topic:Boilermaker")!;
    expect(boiler.contentCount).toBe(4);
    expect(boiler.populated).toBe(true);
  });

  it("adds to (never replaces) a trade's existing graph contribution", () => {
    const seeded = withSeededTrades(baseModel());
    const before = buildHierarchy(seeded).get("topic:Welder")!.contentCount;
    const after = buildHierarchy(
      withKnowledgeCounts(seeded, { Welder: 5 }),
    ).get("topic:Welder")!.contentCount;
    expect(after).toBe(before + 5);
  });

  it("does not inflate concept counts or cluster metrics", () => {
    const seeded = withSeededTrades(baseModel());
    const stamped = withKnowledgeCounts(seeded, { Boilermaker: 9, Welder: 9 });
    // Knowledge Entries are not graph concepts — the "Concepts" counter and the
    // per-trade metrics rollups must be untouched.
    expect(stamped.counts.knowledge).toBe(seeded.counts.knowledge);
    for (const t of stamped.topics) {
      const original = seeded.topics.find((s) => s.id === t.id)!;
      expect(t.metrics).toEqual(original.metrics);
    }
  });

  it("is a no-op (same reference) when nothing changes", () => {
    const seeded = withSeededTrades(baseModel());
    // No trades supplied → every topic stays at 0 → unchanged model returned.
    expect(withKnowledgeCounts(seeded, {})).toBe(seeded);
    // Re-applying identical counts is also a no-op.
    const once = withKnowledgeCounts(seeded, { Boilermaker: 2 });
    expect(withKnowledgeCounts(once, { Boilermaker: 2 })).toBe(once);
  });
});

describe("topicRadiusWeight", () => {
  it("maps knowledge counts to monotonic, non-decreasing size buckets", () => {
    expect(topicRadiusWeight(0)).toBe(0);
    expect(topicRadiusWeight(1)).toBe(0.25);
    expect(topicRadiusWeight(5)).toBe(0.25);
    expect(topicRadiusWeight(6)).toBe(0.5);
    expect(topicRadiusWeight(15)).toBe(0.5);
    expect(topicRadiusWeight(16)).toBe(0.75);
    expect(topicRadiusWeight(40)).toBe(0.75);
    expect(topicRadiusWeight(41)).toBe(1);
    expect(topicRadiusWeight(9999)).toBe(1);
  });

  it("treats a dormant (zero/negative) hub as the smallest bucket", () => {
    expect(topicRadiusWeight(0)).toBe(0);
    expect(topicRadiusWeight(-3)).toBe(0);
  });

  it("never decreases as the count grows", () => {
    let prev = -1;
    for (const c of [0, 1, 5, 6, 15, 16, 40, 41, 500]) {
      const w = topicRadiusWeight(c);
      expect(w).toBeGreaterThanOrEqual(prev);
      prev = w;
    }
  });
});

describe("computeBrainStats", () => {
  it("summarizes the per-trade knowledge distribution from the displayed model", () => {
    const model = withKnowledgeCounts(withSeededTrades(baseModel()), {
      Plumber: 3,
    });
    const stats = computeBrainStats(model);
    expect(stats.totalTrades).toBe(model.topics.length);
    expect(stats.populatedTrades + stats.dormantTrades).toBe(stats.totalTrades);
    // Welder has an ingested video; Plumber has 3 written notes — both populated.
    expect(stats.byTrade.find((t) => t.id === "topic:Welder")!.populated).toBe(true);
    const plumber = stats.byTrade.find((t) => t.id === "topic:Plumber")!;
    expect(plumber.count).toBe(3);
    expect(plumber.entries).toBe(3);
    expect(plumber.populated).toBe(true);
  });

  it("sorts by combined knowledge and reports the extremes", () => {
    const model = withKnowledgeCounts(withSeededTrades(baseModel()), {
      Plumber: 50,
      Carpenter: 2,
    });
    const stats = computeBrainStats(model);
    for (let i = 1; i < stats.byTrade.length; i++) {
      expect(stats.byTrade[i - 1].count).toBeGreaterThanOrEqual(
        stats.byTrade[i].count,
      );
    }
    expect(stats.largest?.id).toBe("topic:Plumber");
    // The smallest POPULATED hub is never a dormant (0-count) trade.
    expect(stats.smallestPopulated?.count).toBeGreaterThan(0);
  });

  it("counts dormant trades and yields no smallestPopulated when all are empty", () => {
    const empty = withSeededTrades(selectMemoryGraphModel(null, [], []));
    const stats = computeBrainStats(empty);
    expect(stats.populatedTrades).toBe(0);
    expect(stats.dormantTrades).toBe(stats.totalTrades);
    expect(stats.largest?.count ?? 0).toBe(0);
    expect(stats.smallestPopulated).toBeNull();
  });
});

describe("fibonacci sphere seeding", () => {
  it("returns unit-length, distinct directions", () => {
    const n = 24;
    const seen = new Set<string>();
    for (let i = 0; i < n; i++) {
      const d = fibonacciSphereDir(i, n);
      const len = Math.hypot(d.x, d.y, d.z);
      expect(len).toBeCloseTo(1, 5);
      const key = `${d.x.toFixed(4)},${d.y.toFixed(4)},${d.z.toFixed(4)}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it("handles the single-point degenerate case", () => {
    expect(fibonacciSphereDir(0, 1)).toEqual({ x: 1, y: 0, z: 0 });
  });
});

describe("buildSpatialLayout", () => {
  const model = withSeededTrades(baseModel());

  it("puts the center at the origin and its ring on the first shell", () => {
    const layout = buildSpatialLayout(model, CORE_ID);
    expect(layout.centerId).toBe(CORE_ID);
    expect(layout.positions.get(CORE_ID)).toEqual({ x: 0, y: 0, z: 0 });
    // Depth-1 nodes sit on the first shell radius.
    for (const [id, hop] of layout.hopFromCenter) {
      if (hop !== 1) continue;
      const p = layout.positions.get(id)!;
      expect(Math.hypot(p.x, p.y, p.z)).toBeCloseTo(SHELL_RADIUS_1, 3);
    }
  });

  it("only keeps nodes within maxHops of the center", () => {
    const layout = buildSpatialLayout(model, CORE_ID, { maxHops: 1 });
    for (const hop of layout.hopFromCenter.values()) {
      expect(hop).toBeLessThanOrEqual(1);
    }
    // Recentering on a trade hub surfaces its own neighborhood.
    const onWelder = buildSpatialLayout(model, "topic:Welder");
    expect(onWelder.centerId).toBe("topic:Welder");
    expect(onWelder.visibleIds).toContain(CORE_ID);
  });

  it("falls back to the core when the requested center is unknown", () => {
    const layout = buildSpatialLayout(model, "does-not-exist");
    expect(layout.centerId).toBe(CORE_ID);
  });

  it("is deterministic — same inputs yield identical positions", () => {
    const a = buildSpatialLayout(model, CORE_ID);
    const b = buildSpatialLayout(model, CORE_ID);
    for (const [id, pa] of a.positions) {
      expect(b.positions.get(id)).toEqual(pa);
    }
  });
});

describe("large-graph visible cap", () => {
  it("never exceeds maxVisible even on a dense synthetic graph", () => {
    const big = buildSyntheticServerGraph(1500);
    const model = selectMemoryGraphModel(big, [], []);
    const layout = buildSpatialLayout(model, CORE_ID, { maxVisible: DEFAULT_MAX_VISIBLE });
    expect(layout.visibleIds.length).toBeLessThanOrEqual(DEFAULT_MAX_VISIBLE);
    // The center and its immediate ring are always retained.
    expect(layout.visibleIds).toContain(CORE_ID);
    const ringKept = [...layout.hopFromCenter.values()].some((h) => h === 1);
    expect(ringKept).toBe(true);
    // Every kept node has a finite position.
    for (const p of layout.positions.values()) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).toBe(true);
    }
  });
});

describe("camera + projection", () => {
  it("clamps pitch to the orbit limit", () => {
    expect(clampPitch(Math.PI)).toBeCloseTo(PITCH_LIMIT, 6);
    expect(clampPitch(-Math.PI)).toBeCloseTo(-PITCH_LIMIT, 6);
    expect(clampPitch(0)).toBe(0);
  });

  it("leaves a point unchanged under a zero rotation", () => {
    const p = { x: 10, y: -20, z: 30 };
    expect(rotatePoint(p, 0, 0)).toEqual(p);
  });

  it("keeps world-space distance under pure rotation", () => {
    const p = { x: 120, y: -40, z: 60 };
    const r = rotatePoint(p, 0.7, 0.3);
    expect(Math.hypot(r.x, r.y, r.z)).toBeCloseTo(Math.hypot(p.x, p.y, p.z), 4);
  });

  it("projects the origin to the viewport center with finite scale", () => {
    const proj = projectPoint({ x: 0, y: 0, z: 0 }, { yaw: 0, pitch: 0, zoom: 1 });
    expect(proj.x).toBe(0);
    expect(proj.y).toBe(0);
    expect(Number.isFinite(proj.scale)).toBe(true);
    expect(proj.scale).toBeGreaterThan(0);
  });

  it("shrinks farther points and grows nearer ones (perspective)", () => {
    const near = projectPoint({ x: 100, y: 0, z: -300 }, { yaw: 0, pitch: 0, zoom: 1 });
    const far = projectPoint({ x: 100, y: 0, z: 300 }, { yaw: 0, pitch: 0, zoom: 1 });
    expect(near.scale).toBeGreaterThan(far.scale);
    expect(near.depth).toBeLessThan(far.depth);
  });

  it("depth cue fades far nodes toward the floor and never leaves 0..1", () => {
    const near = depthCue(-700);
    const far = depthCue(700);
    expect(near).toBeGreaterThan(far);
    for (const d of [-5000, -700, 0, 700, 5000]) {
      const c = depthCue(d);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
    }
  });
});

describe("shell + adjacency helpers", () => {
  it("shell radius grows monotonically with hop", () => {
    expect(shellRadius(0)).toBe(0);
    expect(shellRadius(1)).toBe(SHELL_RADIUS_1);
    expect(shellRadius(2)).toBeGreaterThan(shellRadius(1));
    expect(shellRadius(3)).toBeGreaterThan(shellRadius(2));
  });

  it("builds a symmetric adjacency with no self loops or duplicates", () => {
    const model = withSeededTrades(baseModel());
    const adj = buildAdjacency(model);
    for (const [id, neighbors] of adj) {
      expect(neighbors).not.toContain(id); // no self loops
      expect(new Set(neighbors).size).toBe(neighbors.length); // no dupes
      for (const nb of neighbors) {
        expect(adj.get(nb)).toContain(id); // symmetric
      }
    }
  });

  it("exposes sane defaults", () => {
    expect(DEFAULT_MAX_HOPS).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_MAX_VISIBLE).toBeGreaterThan(0);
  });
});
