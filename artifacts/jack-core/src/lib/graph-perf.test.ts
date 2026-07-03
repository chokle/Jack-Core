import { describe, it, expect } from "vitest";
import {
  GRID_REPULSION_THRESHOLD,
  GRID_CELL,
  GLOW_LOD_SCALE,
  TOPIC_METRICS_SCALE,
  useGridRepulsion,
  gridCoord,
  gridCellKey,
  cullBounds,
  isOffscreen,
  glowVisible,
  showTopicMetrics,
} from "./graph-perf";
import { buildSyntheticServerGraph } from "./graph-stress";
import { selectMemoryGraphModel, CORE_ID } from "./memory-graph";

describe("large-graph repulsion fallback", () => {
  it("uses O(n²) pairwise repulsion at/under the threshold and the grid above it", () => {
    expect(useGridRepulsion(GRID_REPULSION_THRESHOLD)).toBe(false);
    expect(useGridRepulsion(GRID_REPULSION_THRESHOLD - 1)).toBe(false);
    expect(useGridRepulsion(GRID_REPULSION_THRESHOLD + 1)).toBe(true);
    expect(useGridRepulsion(2000)).toBe(true);
  });

  it("maps adjacent world coordinates into the correct grid cells", () => {
    expect(gridCoord(0)).toBe(0);
    expect(gridCoord(GRID_CELL - 0.001)).toBe(0);
    expect(gridCoord(GRID_CELL)).toBe(1);
    expect(gridCoord(-1)).toBe(-1);
  });

  it("gives distinct cells distinct keys across the coordinate ranges the layout produces", () => {
    const seen = new Set<number>();
    // The radial layout spreads nodes across roughly ±6000 world units, i.e.
    // grid rows/cols within ±70. Confirm no two distinct cells collide.
    for (let gx = -70; gx <= 70; gx++) {
      for (let gy = -70; gy <= 70; gy++) {
        const k = gridCellKey(gx, gy);
        expect(seen.has(k)).toBe(false);
        seen.add(k);
      }
    }
    // A node and its 8 neighbors all land on different keys.
    const neighborKeys = new Set<number>();
    for (let ox = -1; ox <= 1; ox++)
      for (let oy = -1; oy <= 1; oy++)
        neighborKeys.add(gridCellKey(10 + ox, 20 + oy));
    expect(neighborKeys.size).toBe(9);
  });
});

describe("viewport culling", () => {
  const cam = { scale: 1, tx: 0, ty: 0 };
  const b = cullBounds(cam, 1000, 800);

  it("keeps a node just inside the padded viewport and culls one just outside", () => {
    // Padding widens the bounds by CULL_PAD (80) beyond the raw viewport.
    expect(isOffscreen(0, 0, b)).toBe(false); // top-left corner, on screen
    expect(isOffscreen(-79, -79, b)).toBe(false); // inside the pad
    expect(isOffscreen(-81, 400, b)).toBe(true); // past the left pad
    expect(isOffscreen(1081, 400, b)).toBe(true); // past the right pad
    expect(isOffscreen(500, 881, b)).toBe(true); // past the bottom pad
  });

  it("scales bounds with the camera so panning/zooming never wrongly culls", () => {
    const zoomed = cullBounds({ scale: 2, tx: 100, ty: 50 }, 1000, 800);
    // A world point mapped to the middle of the screen is always visible.
    const midX = (500 - 100) / 2;
    const midY = (400 - 50) / 2;
    expect(isOffscreen(midX, midY, zoomed)).toBe(false);
  });
});

describe("level-of-detail thresholds", () => {
  it("drops glow for small ordinary nodes only when zoomed past the LOD scale", () => {
    expect(glowVisible(GLOW_LOD_SCALE, "concept", false)).toBe(true);
    expect(glowVisible(GLOW_LOD_SCALE - 0.01, "concept", false)).toBe(false);
    // Topic hubs and emphasized/selected nodes always keep their glow.
    expect(glowVisible(0.1, "topic", false)).toBe(true);
    expect(glowVisible(0.1, "concept", true)).toBe(true);
  });

  it("shows topic composition metrics only at/above the metrics scale", () => {
    expect(showTopicMetrics(TOPIC_METRICS_SCALE)).toBe(true);
    expect(showTopicMetrics(TOPIC_METRICS_SCALE - 0.01)).toBe(false);
    expect(showTopicMetrics(1)).toBe(true);
  });
});

describe("synthetic large-graph model build", () => {
  it("builds a well-formed model with hundreds-to-thousands of nodes without throwing", () => {
    const raw = buildSyntheticServerGraph(1000);
    expect(raw.nodes.length).toBeGreaterThan(1000);
    let model!: ReturnType<typeof selectMemoryGraphModel>;
    expect(() => {
      model = selectMemoryGraphModel(raw, [], []);
    }).not.toThrow();
    // Core + 10 topic hubs + the synthetic nodes all made it into the model.
    expect(model.nodes.some((n) => n.id === CORE_ID)).toBe(true);
    expect(model.nodes.filter((n) => n.kind === "topic").length).toBe(10);
    expect(model.nodes.length).toBeGreaterThan(1000);
    // Every edge references nodes that exist — no dangling endpoints that would
    // make the canvas cull or crash on a missing coordinate.
    const ids = new Set(model.nodes.map((n) => n.id));
    for (const e of model.edges) {
      expect(ids.has(e.a)).toBe(true);
      expect(ids.has(e.b)).toBe(true);
    }
  });

  it("crosses the grid-repulsion threshold at the counts it is meant to exercise", () => {
    const raw = buildSyntheticServerGraph(1000);
    const model = selectMemoryGraphModel(raw, [], []);
    expect(useGridRepulsion(model.nodes.length)).toBe(true);
  });
});
