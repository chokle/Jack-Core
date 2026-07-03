/**
 * Perf-path geometry for the Memory Graph canvas, extracted as pure, dependency-
 * free helpers so the large-graph fast paths — the spatial-grid repulsion
 * fallback, viewport culling, and level-of-detail thresholds — are unit-testable
 * independently of the (imperative, canvas-bound) render loop. `MemoryGraphCanvas`
 * imports these so the drawn behavior and the tested behavior can never drift.
 */

/**
 * Above this node count the canvas switches from O(n²) pairwise repulsion to the
 * spatial-grid fallback, keeping per-frame cost near O(n) on large graphs.
 */
export const GRID_REPULSION_THRESHOLD = 700;

/** Spatial-grid cell size (world units) for the large-graph repulsion fallback. */
export const GRID_CELL = 90;

/**
 * Column stride used to fold a 2D grid cell into a single numeric Map key. Must
 * exceed any realistic grid-row span so two distinct cells never collide onto the
 * same key at the coordinate ranges the layout actually produces.
 */
export const GRID_COLS = 100000;

/**
 * World-space padding added around the viewport when culling, so a node (and its
 * glow) never pops in/out exactly at the screen edge while panning/zooming.
 */
export const CULL_PAD = 80;

/**
 * Below this camera scale the additive glow is skipped for small, ordinary nodes
 * (topic hubs and emphasized/selected nodes always keep theirs) — the glow LOD.
 */
export const GLOW_LOD_SCALE = 0.55;

/** At/above this camera scale, topic hubs render their composition + maturity. */
export const TOPIC_METRICS_SCALE = 0.7;

/** Whether the spatial-grid repulsion fallback should be used for `nodeCount`. */
export function useGridRepulsion(nodeCount: number): boolean {
  return nodeCount > GRID_REPULSION_THRESHOLD;
}

/** Grid column/row index for a single world-space coordinate. */
export function gridCoord(v: number): number {
  return Math.floor(v / GRID_CELL);
}

/** Fold a 2D grid cell (already floored) into a single numeric Map key. */
export function gridCellKey(gx: number, gy: number): number {
  return gx * GRID_COLS + gy;
}

export interface Cam {
  scale: number;
  tx: number;
  ty: number;
}

export interface CullBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** World-space viewport bounds, padded by `CULL_PAD`, for the current camera. */
export function cullBounds(cam: Cam, w: number, h: number): CullBounds {
  return {
    minX: (0 - cam.tx) / cam.scale - CULL_PAD,
    minY: (0 - cam.ty) / cam.scale - CULL_PAD,
    maxX: (w - cam.tx) / cam.scale + CULL_PAD,
    maxY: (h - cam.ty) / cam.scale + CULL_PAD,
  };
}

/** True when a world-space point falls outside the padded viewport bounds. */
export function isOffscreen(x: number, y: number, b: CullBounds): boolean {
  return x < b.minX || x > b.maxX || y < b.minY || y > b.maxY;
}

/**
 * Whether a node's additive glow should be drawn at the current camera scale.
 * Emphasized nodes and topic hubs always glow; small ordinary nodes drop their
 * glow once zoomed out past the LOD threshold.
 */
export function glowVisible(
  scale: number,
  kind: string,
  emphasized: boolean,
): boolean {
  if (emphasized || kind === "topic") return true;
  return scale >= GLOW_LOD_SCALE;
}

/** Whether topic composition/maturity labels should render at this scale. */
export function showTopicMetrics(scale: number): boolean {
  return scale >= TOPIC_METRICS_SCALE;
}
