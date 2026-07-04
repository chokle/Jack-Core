/**
 * graph-spatial — pure, unit-tested geometry + hierarchy for the 2.5D "Live
 * Brain" spatial navigator (SpatialBrainCanvas).
 *
 * The canvas renders Jack's Living Memory as a depth-shelled constellation you
 * can orbit (yaw/pitch), zoom, and recenter (click-to-lock). All the math that
 * decides WHERE a node sits in 3D, HOW the hierarchy fans out from the current
 * center, and HOW a 3D point projects to the 2D canvas lives here — separated
 * from the imperative render loop so drawn behavior and tested behavior can't
 * drift (the same pure-module + colocated-test convention as `graph-perf`).
 *
 * It is deterministic: no RNG, no clock. Given the same model + center + camera
 * it always produces the same layout and projection, so tests pin real numbers.
 */

import {
  CORE_ID,
  TOPIC_PALETTE,
  emptyMetrics,
  finalizeModel,
  type GraphModel,
  type MemoryEdge,
  type MemoryNode,
  type Topic,
} from "./memory-graph";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Orbit camera: azimuth (yaw) + elevation (pitch, clamped) + zoom multiplier. */
export interface SpatialCamera {
  yaw: number;
  pitch: number;
  zoom: number;
}

/** A node projected to the 2D canvas, with its perspective scale + camera depth. */
export interface Projected {
  /** Screen x/y in canvas CSS px, before the viewport-center offset is added. */
  x: number;
  y: number;
  /** Perspective scale (× camera zoom): 1 ≈ at the focal plane, <1 is farther. */
  scale: number;
  /** Rotated camera-space z: larger = farther from the viewer (painter sort). */
  depth: number;
}

/** Per-node structural facts derived from the graph, independent of any camera. */
export interface SpatialNodeInfo {
  id: string;
  /** Parent toward the core in the hierarchy tree (null for the core itself). */
  parentId: string | null;
  /** Hierarchy children (nodes whose parent is this node). */
  childIds: string[];
  /** Neighbors that are neither parent nor child (siblings / cross-links). */
  relatedNodeIds: string[];
  /** Hops from the core in the hierarchy tree (core = 0). */
  depth: number;
  /** 0..1 "how much has been contributed here" — drives sizing + virgin state. */
  strength: number;
  /** Raw contributed-content count (knowledge/videos/mentors, or child count). */
  contentCount: number;
  /** False when nothing has been contributed yet (a "virgin cluster"). */
  populated: boolean;
}

/** The visible slice of the graph around a center, with deterministic 3D coords. */
export interface SpatialLayout {
  centerId: string;
  /** Ids kept in this view (center + everything within `maxHops`, capped). */
  visibleIds: string[];
  /** 3D position per visible id (center at the origin). */
  positions: Map<string, Vec3>;
  /** Hops from the CURRENT center per visible id (center = 0). */
  hopFromCenter: Map<string, number>;
  /** Layout parent (toward the center) per visible id, for spawn/ease origins. */
  layoutParent: Map<string, string | null>;
}

/**
 * The twelve major Red Seal trades Jack seeds as topic hubs so the brain always
 * shows its full breadth — even trades no one has taught yet render as inviting
 * "virgin clusters". The first five reuse the EXACT seeded competency trade
 * labels so their `topic:<label>` ids collapse onto the real hubs instead of
 * duplicating them; the rest are net-new hubs.
 */
export const MAJOR_TRADES: readonly string[] = [
  "Welder",
  "Electrician",
  "Plumber",
  "Carpenter",
  "HVAC/R Technician",
  "Steamfitter/Pipefitter",
  "Sheet Metal Worker",
  "Heavy Duty Equipment Technician",
  "Mobile Crane Operator",
  "Industrial Mechanic (Millwright)",
  "Bricklayer",
  "Boilermaker",
];

function topicIdForTrade(trade: string): string {
  return `topic:${trade}`;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Ensure every major trade exists as a topic hub, appending empty "virgin"
 * hubs for any that the real data hasn't produced yet. Existing topics (and
 * their palette colors + rolled-up metrics) are preserved exactly; only the
 * genuinely-missing trades are added, then the whole model is re-finalized so
 * degree/counts/metrics stay internally consistent.
 *
 * Computed ONCE by the view (not per frame) so the seeded hubs are real,
 * selectable nodes — and so the growth delta keeps flowing from the RAW model,
 * never spuriously "birthing" a seed on load.
 */
export function withSeededTrades(model: GraphModel): GraphModel {
  const existingTrades = new Set(model.topics.map((t) => t.trade));
  const existingIds = new Set(model.nodes.map((n) => n.id));
  const missing = MAJOR_TRADES.filter(
    (trade) => !existingTrades.has(trade) && !existingIds.has(topicIdForTrade(trade)),
  );
  if (missing.length === 0) return model;

  const topics: Topic[] = [...model.topics];
  const nodes: MemoryNode[] = [...model.nodes];
  const edges: MemoryEdge[] = [...model.edges];

  missing.forEach((trade, i) => {
    const id = topicIdForTrade(trade);
    const color = TOPIC_PALETTE[(model.topics.length + i) % TOPIC_PALETTE.length]!;
    topics.push({ id, trade, label: trade, color, metrics: emptyMetrics() });
    nodes.push({ id, kind: "topic", label: trade, topicId: id, color, meta: { trade } });
    edges.push({ a: CORE_ID, b: id, kind: "topic" });
  });

  return finalizeModel(topics, nodes, edges);
}

/** Undirected adjacency list keyed by node id (each neighbor listed once). */
export function buildAdjacency(model: GraphModel): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  const seen = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    let s = seen.get(a);
    if (!s) {
      s = new Set();
      seen.set(a, s);
    }
    if (s.has(b)) return;
    s.add(b);
    let list = adj.get(a);
    if (!list) {
      list = [];
      adj.set(a, list);
    }
    list.push(b);
  };
  for (const n of model.nodes) if (!adj.has(n.id)) adj.set(n.id, []);
  for (const e of model.edges) {
    if (e.a === e.b) continue;
    link(e.a, e.b);
    link(e.b, e.a);
  }
  return adj;
}

/**
 * Structural facts about every node, independent of the current center or
 * camera: its hierarchy depth from the core, its parent toward the core, its
 * children, its non-tree neighbors, and how much has been contributed to it.
 *
 * Depth is BFS shortest-hops from the core. The parent is the depth-(d-1)
 * neighbor with the strongest edge (tie-break by id) so the tree is stable and
 * deterministic. `contentCount` uses real contribution for topic hubs (a hub
 * with only its competency scaffold still reads as an unpopulated virgin
 * cluster) and child count elsewhere.
 */
export function buildHierarchy(model: GraphModel): Map<string, SpatialNodeInfo> {
  const adj = buildAdjacency(model);
  const nodeIds = model.nodes.map((n) => n.id);
  const hasCore = model.nodes.some((n) => n.id === CORE_ID);
  const root = hasCore ? CORE_ID : (nodeIds[0] ?? CORE_ID);

  // BFS depth from the root over undirected adjacency.
  const depth = new Map<string, number>();
  const queue: string[] = [];
  if (adj.has(root) || hasCore) {
    depth.set(root, 0);
    queue.push(root);
  }
  for (let head = 0; head < queue.length; head++) {
    const u = queue[head]!;
    const du = depth.get(u)!;
    for (const v of adj.get(u) ?? []) {
      if (depth.has(v)) continue;
      depth.set(v, du + 1);
      queue.push(v);
    }
  }
  // Disconnected nodes (no path to root) hang directly off the root at depth 1.
  for (const id of nodeIds) if (!depth.has(id)) depth.set(id, id === root ? 0 : 1);

  const edgeWeight = new Map<string, number>();
  for (const e of model.edges) {
    const w = e.weight ?? 1;
    edgeWeight.set(`${e.a}|${e.b}`, w);
    edgeWeight.set(`${e.b}|${e.a}`, w);
  }

  // Deterministic parent: among neighbors one hop closer to the root, pick the
  // strongest edge (tie-break by id). Nodes with no closer neighbor parent to
  // the root (or null for the root itself).
  const parent = new Map<string, string | null>();
  for (const id of nodeIds) {
    if (id === root) {
      parent.set(id, null);
      continue;
    }
    const d = depth.get(id)!;
    let best: string | null = null;
    let bestW = -Infinity;
    for (const v of adj.get(id) ?? []) {
      if ((depth.get(v) ?? Infinity) !== d - 1) continue;
      const w = edgeWeight.get(`${id}|${v}`) ?? 1;
      if (w > bestW || (w === bestW && (best === null || v < best))) {
        best = v;
        bestW = w;
      }
    }
    parent.set(id, best ?? (id === root ? null : root));
  }

  const children = new Map<string, string[]>();
  for (const id of nodeIds) children.set(id, []);
  for (const id of nodeIds) {
    const p = parent.get(id) ?? null;
    if (p && p !== id) children.get(p)?.push(id);
  }
  for (const list of children.values()) list.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const metricsByTrade = new Map(model.topics.map((t) => [t.trade, t.metrics]));

  const info = new Map<string, SpatialNodeInfo>();
  for (const n of model.nodes) {
    const id = n.id;
    const p = parent.get(id) ?? null;
    const childIds = children.get(id) ?? [];
    const childSet = new Set(childIds);
    const related: string[] = [];
    for (const v of adj.get(id) ?? []) {
      if (v === p || childSet.has(v)) continue;
      related.push(v);
    }

    let contentCount: number;
    if (n.kind === "topic") {
      const m = metricsByTrade.get(n.meta.trade ?? "") ?? emptyMetrics();
      contentCount = m.knowledge + m.videos + m.conversations;
    } else {
      contentCount = childIds.length;
    }
    const strength =
      n.kind === "topic"
        ? clamp01(contentCount / 12)
        : clamp01(
            (typeof n.meta.confidence === "number" ? n.meta.confidence : 0.5) *
              0.6 +
              clamp01(childIds.length / 8) * 0.4,
          );

    info.set(id, {
      id,
      parentId: p,
      childIds,
      relatedNodeIds: related,
      depth: depth.get(id) ?? 0,
      strength,
      contentCount,
      populated: contentCount > 0,
    });
  }
  return info;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Unit-sphere direction #i of a deterministic `count`-point fibonacci sphere. */
export function fibonacciSphereDir(i: number, count: number): Vec3 {
  if (count <= 1) return { x: 1, y: 0, z: 0 };
  const y = 1 - ((i + 0.5) / count) * 2;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const phi = i * GOLDEN_ANGLE;
  return { x: Math.cos(phi) * r, y, z: Math.sin(phi) * r };
}

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z);
  if (len < 1e-6) return { x: 0, y: 1, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

/** Two unit vectors spanning the plane perpendicular to `dir` (deterministic). */
function basisPerp(dir: Vec3): [Vec3, Vec3] {
  const ref: Vec3 = Math.abs(dir.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const u = normalize({
    x: dir.y * ref.z - dir.z * ref.y,
    y: dir.z * ref.x - dir.x * ref.z,
    z: dir.x * ref.y - dir.y * ref.x,
  });
  const v = normalize({
    x: dir.y * u.z - dir.z * u.y,
    y: dir.z * u.x - dir.x * u.z,
    z: dir.x * u.y - dir.y * u.x,
  });
  return [u, v];
}

/** Radius (world units) of depth-shell `hop` from the current center. */
export const SHELL_RADIUS_1 = 300;
export const SHELL_STEP = 210;

export function shellRadius(hop: number): number {
  if (hop <= 0) return 0;
  return SHELL_RADIUS_1 + (hop - 1) * SHELL_STEP;
}

/** Default max hops kept visible around the center (deeper branches lazy-load). */
export const DEFAULT_MAX_HOPS = 2;
/** Hard cap on visible nodes so a dense center never blows the frame budget. */
export const DEFAULT_MAX_VISIBLE = 220;

/**
 * Build the deterministic 3D layout around `centerId`: BFS out to `maxHops`,
 * the center at the origin, its immediate ring on a fibonacci sphere, and each
 * deeper node fanned around its layout-parent's outward frame. When the visible
 * set exceeds `maxVisible`, the center + first ring are always kept and deeper
 * nodes are truncated by descending `strength` (then id) so the strongest,
 * most-contributed branches survive the cap.
 */
export function buildSpatialLayout(
  model: GraphModel,
  centerId: string,
  opts: {
    maxHops?: number;
    maxVisible?: number;
    hierarchy?: Map<string, SpatialNodeInfo>;
  } = {},
): SpatialLayout {
  const maxHops = opts.maxHops ?? DEFAULT_MAX_HOPS;
  const maxVisible = opts.maxVisible ?? DEFAULT_MAX_VISIBLE;
  const info = opts.hierarchy ?? buildHierarchy(model);
  const adj = buildAdjacency(model);

  const center = info.has(centerId) ? centerId : CORE_ID;

  // BFS hops from the center, capped at maxHops, recording the discovery parent.
  const hop = new Map<string, number>([[center, 0]]);
  const layoutParent = new Map<string, string | null>([[center, null]]);
  const queue = [center];
  for (let head = 0; head < queue.length; head++) {
    const u = queue[head]!;
    const du = hop.get(u)!;
    if (du >= maxHops) continue;
    const neighbors = (adj.get(u) ?? [])
      .slice()
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const v of neighbors) {
      if (hop.has(v)) continue;
      hop.set(v, du + 1);
      layoutParent.set(v, u);
      queue.push(v);
    }
  }

  // Enforce the visible cap: keep the center + everything at hop ≤ 1, then take
  // the strongest deeper nodes until the budget is spent.
  let visibleIds = [...hop.keys()];
  if (visibleIds.length > maxVisible) {
    const keep = new Set<string>();
    const deep: string[] = [];
    for (const id of visibleIds) {
      if ((hop.get(id) ?? 0) <= 1) keep.add(id);
      else deep.push(id);
    }
    deep.sort((a, b) => {
      const sa = info.get(a)?.strength ?? 0;
      const sb = info.get(b)?.strength ?? 0;
      if (sb !== sa) return sb - sa;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    for (const id of deep) {
      if (keep.size >= maxVisible) break;
      keep.add(id);
    }
    visibleIds = visibleIds.filter((id) => keep.has(id));
  }

  const visibleSet = new Set(visibleIds);
  const positions = new Map<string, Vec3>();
  positions.set(center, { x: 0, y: 0, z: 0 });

  // Depth-1 ring: fibonacci sphere around the center.
  const ring1 = visibleIds
    .filter((id) => hop.get(id) === 1)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  ring1.forEach((id, i) => {
    const dir = fibonacciSphereDir(i, ring1.length);
    positions.set(id, {
      x: dir.x * SHELL_RADIUS_1,
      y: dir.y * SHELL_RADIUS_1,
      z: dir.z * SHELL_RADIUS_1,
    });
  });

  // Deeper shells: fan each parent's kept children around the parent's outward
  // frame so a branch reads as a coherent spray rather than random scatter.
  for (let d = 2; d <= maxHops; d++) {
    const byParent = new Map<string, string[]>();
    for (const id of visibleIds) {
      if (hop.get(id) !== d) continue;
      const p = layoutParent.get(id) ?? center;
      if (!visibleSet.has(p)) continue;
      const list = byParent.get(p) ?? [];
      list.push(id);
      byParent.set(p, list);
    }
    for (const [p, kids] of byParent) {
      const parentPos = positions.get(p) ?? { x: 0, y: 0, z: 0 };
      const outward = normalize(parentPos);
      const [u, v] = basisPerp(outward);
      const along = SHELL_STEP * 0.72;
      const spread = SHELL_STEP * 0.62;
      const sorted = kids.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      sorted.forEach((id, i) => {
        const ang = ((i + 0.5) / sorted.length) * Math.PI * 2;
        const rad = sorted.length === 1 ? 0 : spread;
        positions.set(id, {
          x: parentPos.x + outward.x * along + (Math.cos(ang) * u.x + Math.sin(ang) * v.x) * rad,
          y: parentPos.y + outward.y * along + (Math.cos(ang) * u.y + Math.sin(ang) * v.y) * rad,
          z: parentPos.z + outward.z * along + (Math.cos(ang) * u.z + Math.sin(ang) * v.z) * rad,
        });
      });
    }
  }

  return {
    centerId: center,
    visibleIds,
    positions,
    hopFromCenter: hop,
    layoutParent,
  };
}

/** Clamp pitch to a sane orbit range so the graph never flips upside down. */
export const PITCH_LIMIT = (Math.PI / 180) * 60;

export function clampPitch(pitch: number): number {
  return pitch < -PITCH_LIMIT ? -PITCH_LIMIT : pitch > PITCH_LIMIT ? PITCH_LIMIT : pitch;
}

/** Rotate a world point by the camera's yaw (around Y) then pitch (around X). */
export function rotatePoint(p: Vec3, yaw: number, pitch: number): Vec3 {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const x1 = p.x * cy + p.z * sy;
  const z1 = -p.x * sy + p.z * cy;
  const y1 = p.y;
  const cx = Math.cos(pitch);
  const sx = Math.sin(pitch);
  const y2 = y1 * cx - z1 * sx;
  const z2 = y1 * sx + z1 * cx;
  return { x: x1, y: y2, z: z2 };
}

/** Focal length + virtual camera distance for the perspective projection. */
export const FOCAL = 820;
export const CAMERA_DISTANCE = 620;

/**
 * Project a world point to canvas space for the given camera. `x`/`y` are
 * relative to the viewport center (add width/2, height/2 to place); `scale` is
 * the perspective foreshortening × zoom; `depth` is the rotated z for painter
 * sorting + depth cueing. Guaranteed finite (the denominator is floored).
 */
export function projectPoint(p: Vec3, cam: SpatialCamera): Projected {
  const r = rotatePoint(p, cam.yaw, cam.pitch);
  const denom = Math.max(1, FOCAL + CAMERA_DISTANCE + r.z);
  const persp = FOCAL / denom;
  const scale = persp * cam.zoom;
  return { x: r.x * scale, y: r.y * scale, scale, depth: r.z };
}

/** Depth → 0..1 cue (1 = nearest, fading to `min` at the far shell) for alpha. */
export function depthCue(depth: number, min = 0.35): number {
  // r.z spans roughly ±(few shells); map near (−) → 1, far (+) → min.
  const t = clamp01((depth + 700) / 1400);
  return min + (1 - min) * (1 - t);
}
