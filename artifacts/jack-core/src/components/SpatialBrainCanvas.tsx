import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import {
  CORE_ID,
  isKnowledgeKind,
  rgba,
  type GraphDelta,
  type GraphModel,
  type MemoryNode,
  type NodeKind,
  type RGB,
} from "../lib/memory-graph";
import {
  buildHierarchy,
  buildSpatialLayout,
  clampPitch,
  depthCue,
  projectPoint,
  topicRadiusWeight,
  type SpatialCamera,
  type SpatialNodeInfo,
} from "../lib/graph-spatial";
import {
  MemoryGraphPulseController,
  pulseSegment,
} from "../lib/memory-graph-pulse";
import { useSystemHealth } from "../hooks/use-system-health";
import { ambientMotionEnabled } from "../lib/motion";

/**
 * SpatialBrainCanvas — the 2.5D "Live Brain" spatial navigator.
 *
 * A drop-in sibling of MemoryGraphCanvas (identical handle + props) that renders
 * Jack's Living Memory as a depth-shelled constellation you can ORBIT (drag =
 * yaw/pitch) and ZOOM (wheel / two-finger pinch). All geometry lives in the
 * pure, unit-tested `graph-spatial` module so drawn behavior can't drift from
 * tested behavior. No three.js — a plain 2D canvas with a hand-rolled
 * perspective projection keeps the bundle lean and the render path debuggable.
 *
 * View mode governs how selection behaves. In "full" (default) the WHOLE graph
 * is fanned out from the JACK core (every trade plus its deeper branch) and
 * stays put on selection: a click only EMPHASIZES the picked node and its
 * neighbours (via `selectedId`) and swings the orbit camera so that branch comes
 * to the front — nothing is ever pruned, so every trade stays visible in the
 * background. In "focus" a selection recenters the layout on the picked node and
 * prunes to its local neighbourhood (the legacy drill-in). `focusNode` swings
 * the camera in full mode and recenters in focus mode; `ensureVisible` nudges
 * the camera only when the node is off-screen or on the far side of the orbit.
 */

export interface MemoryGraphHandle {
  zoomIn: () => void;
  zoomOut: () => void;
  reset: () => void;
  getScreenPos: (id: string) => { x: number; y: number; r: number } | null;
  focusNode: (id: string) => void;
  ensureVisible: (id: string) => void;
}

interface Props {
  model: GraphModel;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onHover?: (id: string | null) => void;
  onTogglePin?: (id: string) => void;
  pinnedIds?: Set<string>;
  search: string;
  activeMatchId?: string | null;
  locked: boolean;
  delta?: GraphDelta | null;
  onZoomChange: (pct: number) => void;
  /**
   * False while the graph/video queries are still loading their FIRST payload.
   * Gates the one-time activation burst so a hard reload (empty in-flight model
   * → real model) never falsely fires every populated hub. Defaults to ready.
   */
  dataReady?: boolean;
  /**
   * "full" (default): the whole graph stays centered on the JACK core and a
   * selection only changes emphasis (highlight/dim) — nothing is pruned, so
   * every trade stays visible. "focus": a selection recenters the layout on the
   * picked node and prunes to its local neighborhood (the legacy drill-in view).
   * User-toggled; defaults to full so launch never hides trades on selection.
   */
  viewMode?: "full" | "focus";
}

/** Runtime, per-node render state: eased 3D position + per-frame projection. */
interface SN {
  id: string;
  kind: NodeKind;
  label: string;
  color: RGB;
  status?: string;
  topicId?: string;
  /** Eased world position. */
  x: number;
  y: number;
  z: number;
  /** Layout target world position (the node eases toward this on recenter). */
  tx: number;
  ty: number;
  tz: number;
  radius: number;
  targetRadius: number;
  bornAt: number;
  /** Eased visibility 0..1 (fades in/out as the visible set changes). */
  vis: number;
  targetVis: number;
  populated: boolean;
  /** Per-frame projected screen coords (canvas CSS px) + depth cue. */
  sx: number;
  sy: number;
  sr: number;
  depth: number;
  palpha: number;
}

const BASE_RADII: Record<NodeKind, number> = {
  // Jack is the gateway: the core must stay visually larger than any hub, which
  // grows up to topic * (1 + 1.1) = 25.2 once a trade is fully taught.
  core: 36,
  topic: 12,
  video: 6,
  mentor: 6.5,
  competency: 4.2,
  concept: 4,
  tool: 4,
  equipment: 4,
  material: 4,
  procedure: 4,
  hazard: 4,
  slang: 4,
  certification: 4,
  standard: 4,
  regional_term: 4,
};

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Node radius scaled by accumulated knowledge (mirrors the flat canvas). */
function spatialRadius(n: MemoryNode, degree: number, contentCount = 0): number {
  const base = BASE_RADII[n.kind] ?? 4;
  if (n.kind === "core") return base;
  let weight = 0;
  if (isKnowledgeKind(n.kind)) {
    const sources = n.meta.sourceCount ?? 1;
    const confidence = n.meta.confidence ?? 0.5;
    weight = clamp01(0.55 * clamp01(sources / 5) + 0.45 * clamp01(confidence));
  } else if (n.kind === "topic") {
    // Size a trade hub by how much has been taught there, bucketed so heft reads
    // at a glance (0 dormant / 1–5 / 6–15 / 16–40 / 40+) — see topicRadiusWeight.
    weight = topicRadiusWeight(contentCount);
  } else {
    weight = clamp01(degree / 10);
  }
  return base * (1 + weight * 1.1);
}

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 3;
const DEFAULT_PITCH = -0.3;
/**
 * Hops kept visible in FULL mode. The whole graph (~100 nodes) fits well under
 * the visible cap, so we fan out deep enough to reveal every trade's branch
 * (concepts, competencies, hazards, tools) instead of a shallow 2-hop window.
 * Must stay finite — `buildSpatialLayout`'s deeper-shell loop runs `d <= maxHops`.
 */
const FULL_MAX_HOPS = 8;
const ORBIT_SPEED = 0.006;
const BIRTH_MS = 1600;

const EMPTY_PINNED: Set<string> = new Set();

const PULSE_STATE_RGB: Record<string, RGB> = {
  green: [110, 231, 183],
  purple: [167, 139, 250],
  orange: [251, 146, 60],
  red: [248, 113, 113],
};

function hexPath(c: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  c.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) c.moveTo(x, y);
    else c.lineTo(x, y);
  }
  c.closePath();
}

export const SpatialBrainCanvas = forwardRef<MemoryGraphHandle, Props>(
  function SpatialBrainCanvas(
    {
      model,
      selectedId,
      onSelect,
      onHover,
      onTogglePin,
      pinnedIds,
      search,
      activeMatchId,
      locked,
      delta,
      onZoomChange,
      dataReady,
      viewMode = "full",
    },
    ref,
  ) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const nodesRef = useRef<Map<string, SN>>(new Map());
    const modelRef = useRef<GraphModel>(model);
    const infoRef = useRef<Map<string, SpatialNodeInfo>>(new Map());
    const adjacencyRef = useRef<Map<string, Set<string>>>(new Map());
    const edgeBornRef = useRef<Map<string, number>>(new Map());
    const birthGlowRef = useRef<Map<string, number>>(new Map());
    // Last-seen populated state per topic, so the model-rebuild effect can detect
    // a dormant → firing transition and fire a one-time activation burst.
    const prevPopulatedRef = useRef<Map<string, boolean>>(new Map());
    // Gate activation bursts until the underlying queries have settled once, so a
    // hard reload (empty in-flight model → real model) never bursts every hub.
    const dataReadyRef = useRef(true);
    const hasSettledRef = useRef(false);
    const centerRef = useRef<string>(CORE_ID);
    const camRef = useRef<SpatialCamera>({ yaw: 0, pitch: DEFAULT_PITCH, zoom: 1 });
    // Target the orbit camera eases toward (a focusNode/ensureVisible "swing").
    // null = no swing in flight; any manual drag/zoom clears it.
    const camTargetRef = useRef<SpatialCamera | null>(null);
    const sizeRef = useRef({ w: 1, h: 1, dpr: 1 });
    const lockedRef = useRef(locked);
    const reducedRef = useRef(false);
    const selectedRef = useRef<string | null>(selectedId);
    const viewModeRef = useRef(viewMode);
    const searchRef = useRef("");
    const activeMatchRef = useRef<string | null>(null);
    const hoverRef = useRef<string | null>(null);
    const pinnedRef = useRef<Set<string>>(EMPTY_PINNED);
    const onHoverRef = useRef(onHover);
    const onTogglePinRef = useRef(onTogglePin);
    const starsRef = useRef<{ x: number; y: number; r: number; a: number }[]>([]);
    // Dev-only FPS meter refs (see `showFps`). The rolling frame count is written
    // straight to the DOM from the rAF loop, so measuring the frame rate never
    // itself triggers a React re-render (which would perturb the measurement).
    const fpsElRef = useRef<HTMLDivElement>(null);
    const fpsFramesRef = useRef(0);
    const fpsLastRef = useRef(0);

    selectedRef.current = selectedId;
    viewModeRef.current = viewMode;
    lockedRef.current = locked;
    dataReadyRef.current = dataReady ?? true;
    searchRef.current = search.trim().toLowerCase();
    activeMatchRef.current = activeMatchId ?? null;
    pinnedRef.current = pinnedIds ?? EMPTY_PINNED;
    onHoverRef.current = onHover;
    onTogglePinRef.current = onTogglePin;

    // Dev-only: reveal an on-screen FPS meter when the perf stress harness is
    // active (`?graphStress=N`) or explicitly requested (`?fps=1`). This is the
    // instrument the "confirm 45–60fps" check reads; it is never shown in normal
    // use. Note a headless/preview browser (CPU-rasterized canvas) reports a
    // lower rate than a real GPU-accelerated desktop browser.
    const params =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search)
        : null;
    const showFps =
      !!params &&
      (params.get("fps") === "1" || Number(params.get("graphStress")) > 0);

    // ----- neural flow ("thinking") ----------------------------------------
    const { snapshot, isOffline } = useSystemHealth();
    const pulseColor: RGB = isOffline
      ? PULSE_STATE_RGB.green
      : PULSE_STATE_RGB[snapshot.pulseColor] ?? PULSE_STATE_RGB.green;
    const pulseColorRef = useRef<RGB>(pulseColor);
    pulseColorRef.current = pulseColor;
    const pulseCtrlRef = useRef<MemoryGraphPulseController | null>(null);
    if (!pulseCtrlRef.current) {
      pulseCtrlRef.current = new MemoryGraphPulseController();
    }

    // ----- recenter: re-fan the graph around a new center -------------------
    // Reads/writes refs only, so it can be called freely from effects and the
    // imperative handle without being a dependency.
    const recenterTo = (id: string) => {
      const m = modelRef.current;
      const info = infoRef.current;
      if (!m || m.nodes.length === 0) return;
      // Full mode always fans the WHOLE graph out from the core (deep enough to
      // include every trade's branch), so a selection never prunes other trades
      // and the ~8s model poll can't quietly re-window it back to 2 hops. Focus
      // mode keeps the legacy shallow drill-in around the picked node.
      const layout =
        viewModeRef.current === "full"
          ? buildSpatialLayout(m, CORE_ID, {
              maxHops: FULL_MAX_HOPS,
              hierarchy: info,
            })
          : buildSpatialLayout(m, id, { hierarchy: info });
      centerRef.current = layout.centerId;

      const map = nodesRef.current;
      const now = performance.now();
      const nodeById = new Map(m.nodes.map((n) => [n.id, n]));
      const visSet = new Set(layout.visibleIds);

      for (const vid of layout.visibleIds) {
        const mn = nodeById.get(vid);
        const pos = layout.positions.get(vid);
        if (!mn || !pos) continue;
        const nodeInfo = info.get(vid);
        const target = spatialRadius(
          mn,
          m.degree[vid] ?? 0,
          nodeInfo?.contentCount ?? 0,
        );
        const populated = nodeInfo?.populated ?? true;
        const existing = map.get(vid);
        if (existing) {
          existing.tx = pos.x;
          existing.ty = pos.y;
          existing.tz = pos.z;
          existing.targetRadius = target;
          existing.targetVis = 1;
          existing.kind = mn.kind;
          existing.label = mn.label;
          existing.color = mn.color;
          existing.status = mn.status;
          existing.topicId = mn.topicId;
          existing.populated = populated;
          continue;
        }
        // Spawn a freshly-revealed node at its layout parent so a branch grows
        // outward from the node you clicked, rather than popping in mid-air.
        const parentId = layout.layoutParent.get(vid);
        const parent = parentId ? map.get(parentId) : undefined;
        map.set(vid, {
          id: vid,
          kind: mn.kind,
          label: mn.label,
          color: mn.color,
          status: mn.status,
          topicId: mn.topicId,
          x: parent ? parent.x : pos.x * 0.15,
          y: parent ? parent.y : pos.y * 0.15,
          z: parent ? parent.z : pos.z * 0.15,
          tx: pos.x,
          ty: pos.y,
          tz: pos.z,
          radius: 0.1,
          targetRadius: target,
          bornAt: now,
          vis: 0,
          targetVis: 1,
          populated,
          sx: 0,
          sy: 0,
          sr: 0,
          depth: 0,
          palpha: 0,
        });
      }
      // Everything outside the new window fades out (and is pruned once faded).
      for (const [sid, sn] of map) {
        if (!visSet.has(sid)) sn.targetVis = 0;
      }
    };
    const recenterRef = useRef(recenterTo);
    recenterRef.current = recenterTo;

    // ----- imperative controls (wired to the on-screen buttons) -------------
    const applyZoom = (factor: number) => {
      // A manual zoom cancels any in-flight camera swing so the user stays in control.
      camTargetRef.current = null;
      const cam = camRef.current;
      cam.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cam.zoom * factor));
      onZoomChange(Math.round(cam.zoom * 100));
    };

    // Swing the orbit camera so a node rotates to the front-and-center of the
    // view (restores the old flat canvas's focusNode "jump"): aim yaw/pitch at
    // the node's world position and gently zoom in, never out. The frame loop
    // eases camRef toward this target; any manual drag/zoom cancels it.
    const orientCameraTo = (id: string) => {
      const n = nodesRef.current.get(id);
      if (!n) return;
      // Aim at the layout target (not the mid-ease position) so a freshly
      // revealed branch still resolves to a stable orientation.
      const horiz = Math.hypot(n.tx, n.tz);
      const cam = camRef.current;
      if (horiz < 1e-3 && Math.abs(n.ty) < 1e-3) {
        // The core sits at the origin — restore the default framing.
        const zoom = Math.max(cam.zoom, 1);
        camTargetRef.current = { yaw: 0, pitch: DEFAULT_PITCH, zoom };
        onZoomChange(Math.round(zoom * 100));
        return;
      }
      const zoom = Math.min(MAX_ZOOM, Math.max(cam.zoom, 1.15));
      camTargetRef.current = {
        yaw: Math.PI - Math.atan2(n.tx, n.tz),
        pitch: clampPitch(-Math.atan2(n.ty, horiz)),
        zoom,
      };
      onZoomChange(Math.round(zoom * 100));
    };

    // Whether a node needs the camera swung to it: true when it projects
    // off-screen or onto the far hemisphere of the orbit (so an already-framed
    // selection just emphasizes without moving the camera).
    const needsOrient = (id: string): boolean => {
      const n = nodesRef.current.get(id);
      if (!n) return false;
      const proj = projectPoint({ x: n.tx, y: n.ty, z: n.tz }, camRef.current);
      if (proj.depth > 0) return true;
      const { w, h } = sizeRef.current;
      const sx = w / 2 + proj.x;
      const sy = h / 2 + proj.y;
      const margin = Math.min(w, h) * 0.18;
      return sx < margin || sx > w - margin || sy < margin || sy > h - margin;
    };

    useImperativeHandle(ref, () => ({
      zoomIn: () => applyZoom(1.2),
      zoomOut: () => applyZoom(1 / 1.2),
      reset: () => {
        const cam = camRef.current;
        camTargetRef.current = null;
        cam.yaw = 0;
        cam.pitch = DEFAULT_PITCH;
        cam.zoom = 1;
        recenterRef.current(CORE_ID);
        onZoomChange(100);
      },
      getScreenPos: (id: string) => {
        const n = nodesRef.current.get(id);
        if (!n || n.vis < 0.05) return null;
        const { w, h } = sizeRef.current;
        const proj = projectPoint({ x: n.x, y: n.y, z: n.z }, camRef.current);
        return {
          x: w / 2 + proj.x,
          y: h / 2 + proj.y,
          r: Math.max(2, n.radius * proj.scale),
        };
      },
      focusNode: (id: string) => {
        // Focus view drills in by recentering/pruning around the node. Full view
        // keeps the whole graph and instead swings the orbit camera so the
        // node's branch comes to the front (restores the old canvas's "jump").
        if (viewModeRef.current === "focus") recenterRef.current(id);
        else orientCameraTo(id);
      },
      ensureVisible: (id: string) => {
        // Full view: swing the camera only when the node is off-screen or on the
        // far side of the orbit, so an already-framed selection just emphasizes.
        // Focus view already recenters the selection to the middle.
        if (viewModeRef.current === "full" && needsOrient(id)) orientCameraTo(id);
      },
    }));

    // ----- rebuild structure whenever the model changes ---------------------
    useEffect(() => {
      modelRef.current = model;
      infoRef.current = buildHierarchy(model);

      // Knowledge-aware activation: when a dormant trade gains its FIRST piece of
      // knowledge (populated false → true across a rebuild), fire a one-time
      // activation burst on its hub; thereafter it lives permanently in the firing
      // topology below. Suppressed under reduced-motion / locked, like the
      // delta-driven bursts.
      {
        const prev = prevPopulatedRef.current;
        const reduced = !ambientMotionEnabled();
        // Only burst once the queries have settled AND we've already seeded from
        // one settled model. A hard reload builds an empty in-flight model first,
        // so the first settled rebuild just records the baseline — without this
        // gate every populated trade would falsely burst the instant data lands.
        // Genuine later transitions (a trade gains its first entry) still burst.
        const ready = dataReadyRef.current;
        const canBurst =
          ready && hasSettledRef.current && !reduced && !lockedRef.current;
        const nowMs = performance.now();
        for (const t of model.topics) {
          const nowPop = infoRef.current.get(t.id)?.populated ?? false;
          if (canBurst && prev.get(t.id) === false && nowPop) {
            birthGlowRef.current.set(t.id, nowMs);
          }
          prev.set(t.id, nowPop);
        }
        if (ready) hasSettledRef.current = true;
      }

      const adj = new Map<string, Set<string>>();
      for (const e of model.edges) {
        if (!adj.has(e.a)) adj.set(e.a, new Set());
        if (!adj.has(e.b)) adj.set(e.b, new Set());
        adj.get(e.a)!.add(e.b);
        adj.get(e.b)!.add(e.a);
      }
      adjacencyRef.current = adj;

      // Neural-flow topology from the LIVE graph (never hardcoded to trades).
      const topicIds = new Set(model.topics.map((t) => t.id));
      const coreNeighbors = adj.get(CORE_ID);
      const hubIds: string[] = [];
      const membersByHub: Record<string, string[]> = {};
      for (const t of model.topics) {
        if (!coreNeighbors?.has(t.id)) continue;
        // Knowledge-aware firing: only hubs that actually hold knowledge fire. A
        // dormant (virgin) trade stays dark until its first contribution — then
        // the model rebuilds, it enters this list, and it fires from then on.
        if (!infoRef.current.get(t.id)?.populated) continue;
        hubIds.push(t.id);
        const members: string[] = [];
        for (const nb of adj.get(t.id) ?? []) {
          if (nb === CORE_ID || topicIds.has(nb)) continue;
          members.push(nb);
        }
        membersByHub[t.id] = members;
      }
      pulseCtrlRef.current?.setTopology({ coreId: CORE_ID, hubIds, membersByHub });

      // Keep the current center if it still exists, else fall back to the core.
      const exists = model.nodes.some((n) => n.id === centerRef.current);
      recenterRef.current(exists ? centerRef.current : CORE_ID);

      // Track edge births so new connections fade in.
      const born = edgeBornRef.current;
      const now = performance.now();
      const live = new Set<string>();
      for (const e of model.edges) {
        const key = `${e.a}->${e.b}:${e.kind}`;
        live.add(key);
        if (!born.has(key)) born.set(key, now);
      }
      for (const key of [...born.keys()]) if (!live.has(key)) born.delete(key);
    }, [model]);

    // Selection behavior depends on the view mode. In "focus" mode a selection
    // recenters the layout on the picked node (legacy drill-in: prunes to its
    // neighborhood). In "full" mode selection is emphasis-only — selectedRef
    // already drives the per-frame highlight/dim, so the global graph stays put
    // and no trades are hidden. Reads viewModeRef (not viewMode) so toggling the
    // mode doesn't re-run this effect; the transition below owns that.
    useEffect(() => {
      if (viewModeRef.current === "focus") {
        recenterRef.current(selectedId ?? CORE_ID);
      }
    }, [selectedId]);

    // View-mode transition: entering "full" rebuilds the whole graph around the
    // core (a prior focus view may have pruned it away) and swings back to the
    // default framing so the whole graph reads at a glance; entering "focus"
    // drills into the current selection (or the core when nothing is selected).
    useEffect(() => {
      if (viewMode === "full") {
        recenterRef.current(CORE_ID);
        camTargetRef.current = { yaw: 0, pitch: DEFAULT_PITCH, zoom: 1 };
        onZoomChange(100);
      } else {
        recenterRef.current(selectedRef.current ?? CORE_ID);
      }
    }, [viewMode]);

    // Birth bursts from the shared snapshot diff (suppressed when locked/reduced).
    useEffect(() => {
      if (!delta) return;
      const reduced = !ambientMotionEnabled();
      if (reduced || lockedRef.current) return;
      if (!delta.addedNodeIds.length) return;
      const now = performance.now();
      for (const id of delta.addedNodeIds) birthGlowRef.current.set(id, now);
    }, [delta]);

    // ----- render loop ------------------------------------------------------
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      reducedRef.current = !ambientMotionEnabled();
      pulseCtrlRef.current?.setEnabled(!reducedRef.current && !locked);

      const seedStars = (w: number, h: number) => {
        const count = Math.round((w * h) / 7000);
        const stars = [];
        for (let i = 0; i < count; i++) {
          stars.push({
            x: Math.random() * w,
            y: Math.random() * h,
            r: Math.random() * 1.1 + 0.2,
            a: Math.random() * 0.4 + 0.05,
          });
        }
        starsRef.current = stars;
      };

      const resize = () => {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const rect = canvas.getBoundingClientRect();
        const w = Math.max(1, rect.width);
        const h = Math.max(1, rect.height);
        sizeRef.current = { w, h, dpr };
        canvas.width = Math.floor(w * dpr);
        canvas.height = Math.floor(h * dpr);
        seedStars(w, h);
      };
      resize();
      const ro = new ResizeObserver(resize);
      ro.observe(canvas);

      // ----- picking (nearest projected node under the cursor) --------------
      const pick = (sx: number, sy: number): SN | null => {
        let best: SN | null = null;
        let bestDepth = Infinity;
        for (const n of nodesRef.current.values()) {
          if (n.vis < 0.15) continue;
          const dx = n.sx - sx;
          const dy = n.sy - sy;
          const d = Math.hypot(dx, dy);
          const hit = n.sr + 8;
          // Prefer the nearest-to-viewer node among overlapping hits.
          if (d < hit && n.depth < bestDepth) {
            best = n;
            bestDepth = n.depth;
          }
        }
        return best;
      };

      const localXY = (e: PointerEvent) => {
        const rect = canvas.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
      };

      // ----- pointer interaction (orbit + pinch zoom + click select) --------
      const pointers = new Map<number, { x: number; y: number }>();
      let dragging = false;
      let moved = 0;
      let last = { x: 0, y: 0 };
      let pinchDist = 0;

      const onPointerDown = (e: PointerEvent) => {
        if (locked) return;
        // A manual grab cancels any in-flight camera swing.
        camTargetRef.current = null;
        const p = localXY(e);
        pointers.set(e.pointerId, p);
        if (pointers.size === 1) {
          dragging = true;
          moved = 0;
          last = p;
        } else if (pointers.size === 2) {
          dragging = false;
          const pts = [...pointers.values()];
          pinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        }
        try {
          canvas.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      };

      const onPointerMove = (e: PointerEvent) => {
        const p = localXY(e);
        if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);

        if (pointers.size >= 2) {
          const pts = [...pointers.values()];
          const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
          if (pinchDist > 0 && dist > 0) applyZoom(dist / pinchDist);
          pinchDist = dist;
          return;
        }

        if (dragging && !locked) {
          const dx = p.x - last.x;
          const dy = p.y - last.y;
          moved += Math.abs(dx) + Math.abs(dy);
          const cam = camRef.current;
          cam.yaw += dx * ORBIT_SPEED;
          cam.pitch = clampPitch(cam.pitch - dy * ORBIT_SPEED);
          last = p;
        } else {
          const hit = pick(p.x, p.y);
          const id = hit?.id ?? null;
          if (id !== hoverRef.current) {
            hoverRef.current = id;
            onHoverRef.current?.(id);
            canvas.style.cursor = id ? "pointer" : locked ? "default" : "grab";
          }
        }
      };

      const onPointerUp = (e: PointerEvent) => {
        const wasDragging = dragging;
        pointers.delete(e.pointerId);
        if (pointers.size < 2) pinchDist = 0;
        try {
          canvas.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
        if (locked) return;
        if (wasDragging && moved < 6) {
          const p = localXY(e);
          const hit = pick(p.x, p.y);
          // Only (re)select on a real node hit. An empty-space click no longer
          // clears the selection — the floating inspector is a window, not a
          // modal, so it stays open (and the node stays highlighted) until the
          // user closes it via X or Escape.
          if (hit) onSelect(hit.id);
        }
        dragging = false;
      };

      const onWheel = (e: WheelEvent) => {
        if (locked) return;
        e.preventDefault();
        applyZoom(e.deltaY < 0 ? 1.1 : 1 / 1.1);
      };

      const onLeave = () => {
        if (hoverRef.current !== null) {
          hoverRef.current = null;
          onHoverRef.current?.(null);
        }
      };

      const onDblClick = (e: MouseEvent) => {
        if (locked) return;
        const rect = canvas.getBoundingClientRect();
        const hit = pick(e.clientX - rect.left, e.clientY - rect.top);
        if (hit && hit.kind !== "core") onTogglePinRef.current?.(hit.id);
      };

      canvas.addEventListener("pointerdown", onPointerDown);
      canvas.addEventListener("pointermove", onPointerMove);
      canvas.addEventListener("pointerup", onPointerUp);
      canvas.addEventListener("pointerleave", onLeave);
      canvas.addEventListener("dblclick", onDblClick);
      canvas.addEventListener("wheel", onWheel, { passive: false });

      // ----- ease positions/visibility toward their targets -----------------
      const step = (dt: number) => {
        const map = nodesRef.current;
        const posK = Math.min(1, 0.14 * dt);
        const visK = Math.min(1, 0.16 * dt);
        const radK = Math.min(1, 0.12 * dt);
        for (const [id, n] of map) {
          n.x += (n.tx - n.x) * posK;
          n.y += (n.ty - n.y) * posK;
          n.z += (n.tz - n.z) * posK;
          n.vis += (n.targetVis - n.vis) * visK;
          if (n.radius !== n.targetRadius) {
            n.radius += (n.targetRadius - n.radius) * radK;
            if (Math.abs(n.targetRadius - n.radius) < 0.02) n.radius = n.targetRadius;
          }
          if (n.targetVis === 0 && n.vis < 0.02) map.delete(id);
        }
      };

      // ----- drawing --------------------------------------------------------
      const draw = (time: number) => {
        const { w, h, dpr } = sizeRef.current;
        const cam = camRef.current;
        const map = nodesRef.current;
        const sel = selectedRef.current;
        const q = searchRef.current;
        const active = activeMatchRef.current;
        const adj = adjacencyRef.current;

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const bg = ctx.createLinearGradient(0, 0, 0, h);
        bg.addColorStop(0, "rgb(8, 12, 24)");
        bg.addColorStop(1, "rgb(6, 9, 18)");
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, w, h);

        ctx.save();
        for (const s of starsRef.current) {
          ctx.fillStyle = `rgba(180, 200, 255, ${s.a})`;
          ctx.fillRect(s.x, s.y, s.r, s.r);
        }
        ctx.restore();

        // Project every live node to screen space (2.5D → 2D).
        const cx = w / 2;
        const cy = h / 2;
        const drawn: SN[] = [];
        for (const n of map.values()) {
          if (n.vis < 0.02) continue;
          const proj = projectPoint({ x: n.x, y: n.y, z: n.z }, cam);
          n.sx = cx + proj.x;
          n.sy = cy + proj.y;
          n.sr = Math.max(1, n.radius * proj.scale);
          n.depth = proj.depth;
          n.palpha = depthCue(proj.depth) * clamp01(n.vis);
          drawn.push(n);
        }
        // Painter's order: farthest (largest depth) first.
        drawn.sort((a, b) => b.depth - a.depth);

        const related = sel && adj.has(sel) ? (adj.get(sel) as Set<string>) : null;
        const dimmed = (id: string): boolean => {
          if (q) {
            const node = map.get(id);
            return !(node && node.label.toLowerCase().includes(q));
          }
          if (sel) return id !== sel && !(related?.has(id) ?? false);
          return false;
        };

        // Edges (drawn under the nodes, depth-cued by their dimmer endpoint).
        for (const e of modelRef.current.edges) {
          const a = map.get(e.a);
          const b = map.get(e.b);
          if (!a || !b || a.vis < 0.05 || b.vis < 0.05) continue;
          const isSel = sel && (e.a === sel || e.b === sel);
          const faded = dimmed(e.a) && dimmed(e.b);
          let alpha =
            e.kind === "competency" ? 0.09 : e.kind === "knowledge" ? 0.17 : 0.15;
          if (isSel) alpha = 0.55;
          else if (faded) alpha = 0.04;
          const cue = Math.min(a.palpha, b.palpha);
          ctx.strokeStyle = rgba(b.color, alpha * cue);
          ctx.lineWidth = (isSel ? 1.6 : 0.8) * Math.min(a.sr, b.sr) * 0.14 + 0.2;
          ctx.beginPath();
          ctx.moveTo(a.sx, a.sy);
          ctx.lineTo(b.sx, b.sy);
          ctx.stroke();
        }

        // Additive node glows.
        ctx.globalCompositeOperation = "lighter";
        const birthMap = birthGlowRef.current;
        for (const n of drawn) {
          if (n.kind === "core") continue;
          const emphasized = n.id === sel || n.id === active;
          drawNodeGlow(ctx, n, time, dimmed(n.id), emphasized);
          const bAt = birthMap.get(n.id);
          if (bAt != null) {
            const bp = (time - bAt) / BIRTH_MS;
            if (bp >= 1) birthMap.delete(n.id);
            else drawBirthBurst(ctx, n, bp);
          }
        }
        ctx.globalCompositeOperation = "source-over";

        // Node bodies + rings.
        for (const n of drawn) {
          if (n.kind === "core") continue;
          drawNodeBody(
            ctx,
            n,
            time,
            dimmed(n.id),
            n.id === sel,
            n.id === hoverRef.current,
            pinnedRef.current.has(n.id),
            n.id === active,
          );
        }

        // Neural-flow pulses (screen space, resolved against live projections).
        const pulseCtrl = pulseCtrlRef.current;
        if (pulseCtrl && pulseCtrl.hasActivity()) {
          const pcol = pulseCtrl.getColor();
          ctx.globalCompositeOperation = "lighter";
          ctx.lineCap = "round";
          for (const p of pulseCtrl.getPulses()) {
            const a = map.get(p.fromId);
            const b = map.get(p.toId);
            if (!a || !b || a.vis < 0.1 || b.vis < 0.1) continue;
            const isPrimary = p.kind === "primary";
            const seg = pulseSegment(
              a.sx,
              a.sy,
              b.sx,
              b.sy,
              p.t,
              isPrimary ? 0.16 : 0.11,
            );
            if (!seg) continue;
            const { tx, ty, hx, hy } = seg;
            const trail = ctx.createLinearGradient(tx, ty, hx, hy);
            trail.addColorStop(0, rgba(pcol, 0));
            trail.addColorStop(1, rgba(pcol, isPrimary ? 0.5 : 0.32));
            ctx.strokeStyle = trail;
            ctx.lineWidth = isPrimary ? 2.4 : 1.5;
            ctx.beginPath();
            ctx.moveTo(tx, ty);
            ctx.lineTo(hx, hy);
            ctx.stroke();
            const headR = isPrimary ? 3.6 : 2.3;
            const glow = ctx.createRadialGradient(hx, hy, 0, hx, hy, headR * 2.4);
            glow.addColorStop(0, rgba(pcol, isPrimary ? 0.6 : 0.42));
            glow.addColorStop(1, rgba(pcol, 0));
            ctx.fillStyle = glow;
            ctx.beginPath();
            ctx.arc(hx, hy, headR * 2.4, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.lineCap = "butt";
          ctx.globalCompositeOperation = "source-over";
        }

        // Topic labels (only for reasonably near/visible hubs).
        ctx.textAlign = "center";
        for (const t of modelRef.current.topics) {
          const hub = map.get(t.id);
          if (!hub || hub.vis < 0.25) continue;
          const faded = dimmed(t.id);
          const fontPx = Math.max(8, Math.min(15, 12 * (hub.sr / 12)));
          ctx.font = `700 ${fontPx}px 'Space Mono', monospace`;
          ctx.fillStyle = rgba([235, 240, 255], (faded ? 0.25 : 0.85) * hub.palpha);
          ctx.fillText(t.label.toUpperCase(), hub.sx, hub.sy - hub.sr - 8);
          // Virgin cluster affordance: an unpopulated hub invites the first
          // contribution rather than reading as broken/empty.
          if (!hub.populated) {
            ctx.font = `500 ${Math.max(7, fontPx * 0.72)}px 'Space Mono', monospace`;
            ctx.fillStyle = rgba([255, 170, 90], (faded ? 0.3 : 0.7) * hub.palpha);
            ctx.fillText("+ be the first", hub.sx, hub.sy + hub.sr + 12);
          }
        }

        // The JACK hexagon core, on top.
        const core = map.get(CORE_ID);
        if (core && core.vis > 0.02) drawCore(ctx, core, time);
      };

      let raf = 0;
      let lastT = performance.now();
      fpsLastRef.current = lastT;
      const frame = (t: number) => {
        const dt = Math.min(2, Math.max(0, (t - lastT) / 16.67));
        lastT = t;
        if (!document.hidden) {
          // Ease an in-flight camera swing (focusNode / ensureVisible) toward its
          // target before stepping/drawing. Yaw takes the shortest angular path.
          const camTarget = camTargetRef.current;
          if (camTarget) {
            const cam = camRef.current;
            const k = Math.min(1, 0.14 * dt);
            let dyaw = camTarget.yaw - cam.yaw;
            dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
            const dpitch = camTarget.pitch - cam.pitch;
            const dzoom = camTarget.zoom - cam.zoom;
            cam.yaw += dyaw * k;
            cam.pitch += dpitch * k;
            cam.zoom += dzoom * k;
            if (
              Math.abs(dyaw) < 0.002 &&
              Math.abs(dpitch) < 0.002 &&
              Math.abs(dzoom) < 0.002
            ) {
              cam.yaw = camTarget.yaw;
              cam.pitch = camTarget.pitch;
              cam.zoom = camTarget.zoom;
              camTargetRef.current = null;
            }
          }
          step(dt);
          const pulse = pulseCtrlRef.current;
          if (pulse) {
            pulse.setColor(pulseColorRef.current);
            pulse.update(t);
          }
          draw(t);
          // Rolling FPS over ~500ms windows, written to the meter DOM node when
          // it is mounted (dev-only). Otherwise just two integer ops per frame.
          fpsFramesRef.current += 1;
          if (t - fpsLastRef.current >= 500) {
            const fps = Math.round(
              (fpsFramesRef.current * 1000) / (t - fpsLastRef.current),
            );
            if (fpsElRef.current) fpsElRef.current.textContent = `${fps} fps`;
            fpsFramesRef.current = 0;
            fpsLastRef.current = t;
          }
        }
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);

      return () => {
        cancelAnimationFrame(raf);
        ro.disconnect();
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointermove", onPointerMove);
        canvas.removeEventListener("pointerup", onPointerUp);
        canvas.removeEventListener("pointerleave", onLeave);
        canvas.removeEventListener("dblclick", onDblClick);
        canvas.removeEventListener("wheel", onWheel);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [locked]);

    return (
      <>
        <canvas
          ref={canvasRef}
          className="absolute inset-0 h-full w-full touch-none"
          style={{ cursor: locked ? "default" : "grab" }}
        />
        {showFps && (
          <div
            ref={fpsElRef}
            className="pointer-events-none absolute left-2 top-2 z-20 rounded bg-black/70 px-2 py-1 font-mono text-xs tabular-nums text-emerald-400"
          >
            … fps
          </div>
        )}
      </>
    );
  },
);

// ---------------------------------------------------------------------------
function nodeIntensity(node: SN, time: number): number {
  if (node.kind === "video") {
    if (node.status === "failed") return 0.7;
    if (node.status && node.status !== "completed") {
      return 0.5 + 0.5 * (0.5 + 0.5 * Math.sin(time * 0.005 + node.sx));
    }
  }
  return 1;
}

function drawBirthBurst(c: CanvasRenderingContext2D, node: SN, p: number) {
  const ease = 1 - (1 - p) * (1 - p);
  const col = node.color;
  const ringR = node.sr * (1.5 + ease * 6);
  c.strokeStyle = rgba(col, (1 - p) * 0.7);
  c.lineWidth = (1 - p) * 2 + 0.4;
  c.beginPath();
  c.arc(node.sx, node.sy, ringR, 0, Math.PI * 2);
  c.stroke();
  const flash = Math.max(0, 1 - p * 1.6);
  if (flash > 0) {
    const glowR = node.sr * 4.5;
    const g = c.createRadialGradient(node.sx, node.sy, 0, node.sx, node.sy, glowR);
    g.addColorStop(0, rgba(col, 0.75 * flash));
    g.addColorStop(0.5, rgba(col, 0.2 * flash));
    g.addColorStop(1, rgba(col, 0));
    c.fillStyle = g;
    c.beginPath();
    c.arc(node.sx, node.sy, glowR, 0, Math.PI * 2);
    c.fill();
  }
}

function drawNodeGlow(
  c: CanvasRenderingContext2D,
  node: SN,
  time: number,
  dim: boolean,
  emphasized = false,
) {
  // Dormant hubs (a trade with no knowledge yet) don't fire — they breathe a
  // faint, slow idle glow so they read as "asleep, waiting for the first
  // contribution" rather than active. Selection/active still gets the full glow
  // below so clicking a virgin hub is clearly acknowledged.
  if (node.kind === "topic" && !node.populated && !emphasized) {
    const breath = 0.5 + 0.5 * Math.sin(time * 0.0018 + node.sx * 0.01);
    const idle = (0.12 + 0.06 * breath) * (dim ? 0.4 : 1) * node.palpha;
    if (idle <= 0) return;
    const gr = node.sr * 3.2;
    const ig = c.createRadialGradient(node.sx, node.sy, 0, node.sx, node.sy, gr);
    ig.addColorStop(0, rgba(node.color, idle));
    ig.addColorStop(1, rgba(node.color, 0));
    c.fillStyle = ig;
    c.beginPath();
    c.arc(node.sx, node.sy, gr, 0, Math.PI * 2);
    c.fill();
    return;
  }
  let intensity = nodeIntensity(node, time) * (dim ? 0.3 : 1) * node.palpha;
  let glowR = node.sr * 5;
  if (emphasized) {
    const pulse = 0.5 + 0.5 * Math.sin(time * 0.006);
    intensity *= 1.35 + 0.55 * pulse;
    glowR *= 1.15 + 0.15 * pulse;
  }
  const col =
    node.kind === "video" && node.status === "failed"
      ? ([239, 90, 90] as RGB)
      : node.color;
  const g = c.createRadialGradient(node.sx, node.sy, 0, node.sx, node.sy, glowR);
  g.addColorStop(0, rgba(col, 0.5 * intensity));
  g.addColorStop(0.4, rgba(col, 0.12 * intensity));
  g.addColorStop(1, rgba(col, 0));
  c.fillStyle = g;
  c.beginPath();
  c.arc(node.sx, node.sy, glowR, 0, Math.PI * 2);
  c.fill();
}

function drawNodeBody(
  c: CanvasRenderingContext2D,
  node: SN,
  time: number,
  dim: boolean,
  selected: boolean,
  hovered: boolean,
  pinned: boolean,
  active = false,
) {
  const r = node.sr;
  const intensity = nodeIntensity(node, time) * (dim ? 0.4 : 1);
  const a = node.palpha;
  const col =
    node.kind === "video" && node.status === "failed"
      ? ([239, 90, 90] as RGB)
      : node.color;

  // Virgin hubs render as a hollow dashed ring (awaiting first contribution).
  if (node.kind === "topic" && !node.populated) {
    c.save();
    c.strokeStyle = rgba(col, Math.min(1, 0.6 * intensity + 0.15) * a);
    c.lineWidth = 1.4;
    c.setLineDash([3.5, 3]);
    c.beginPath();
    c.arc(node.sx, node.sy, r, 0, Math.PI * 2);
    c.stroke();
    c.restore();
  } else {
    c.fillStyle = rgba(col, Math.min(1, 0.8 * intensity + 0.2) * a);
    c.beginPath();
    c.arc(node.sx, node.sy, r, 0, Math.PI * 2);
    c.fill();
  }

  if (selected) {
    const pulse = 0.5 + 0.5 * Math.sin(time * 0.006);
    c.strokeStyle = rgba([255, 255, 255], (0.22 + 0.33 * pulse) * a);
    c.lineWidth = 1 + pulse;
    c.beginPath();
    c.arc(node.sx, node.sy, r + 8 + pulse * 6, 0, Math.PI * 2);
    c.stroke();
  }

  if (active && !selected) {
    const pulse = 0.5 + 0.5 * Math.sin(time * 0.008);
    c.strokeStyle = rgba(col, (0.55 + 0.35 * pulse) * a);
    c.lineWidth = 1.6;
    c.beginPath();
    c.arc(node.sx, node.sy, r + 6 + pulse * 5, 0, Math.PI * 2);
    c.stroke();
  }

  if (selected || hovered) {
    c.strokeStyle = rgba([255, 255, 255], (selected ? 0.9 : 0.5) * a);
    c.lineWidth = selected ? 2 : 1.2;
    c.beginPath();
    c.arc(node.sx, node.sy, r + 5, 0, Math.PI * 2);
    c.stroke();
  }

  if (pinned) {
    c.save();
    c.strokeStyle = rgba(col, 0.95 * a);
    c.lineWidth = 1.4;
    c.setLineDash([3, 2.5]);
    c.beginPath();
    c.arc(node.sx, node.sy, r + 9, 0, Math.PI * 2);
    c.stroke();
    c.restore();
  }
}

function drawCore(c: CanvasRenderingContext2D, core: SN, time: number) {
  const pulse = 1 + 0.05 * Math.sin(time * 0.002);
  const r = core.sr * pulse;
  const a = clamp01(core.vis);

  c.globalCompositeOperation = "lighter";
  const glowR = r * 4;
  const g = c.createRadialGradient(core.sx, core.sy, 0, core.sx, core.sy, glowR);
  g.addColorStop(0, rgba(core.color, 0.5 * a));
  g.addColorStop(0.5, rgba(core.color, 0.12 * a));
  g.addColorStop(1, rgba(core.color, 0));
  c.fillStyle = g;
  c.beginPath();
  c.arc(core.sx, core.sy, glowR, 0, Math.PI * 2);
  c.fill();
  c.globalCompositeOperation = "source-over";

  hexPath(c, core.sx, core.sy, r);
  const fill = c.createRadialGradient(core.sx, core.sy, 0, core.sx, core.sy, r);
  fill.addColorStop(0, "rgba(30, 22, 14, 0.95)");
  fill.addColorStop(1, "rgba(14, 12, 18, 0.95)");
  c.fillStyle = fill;
  c.fill();
  c.lineWidth = 2;
  c.strokeStyle = rgba(core.color, 0.9 * a);
  c.stroke();

  hexPath(c, core.sx, core.sy, r * 0.7);
  c.lineWidth = 1;
  c.strokeStyle = rgba(core.color, 0.35 * a);
  c.stroke();

  c.fillStyle = `rgba(255, 255, 255, ${0.96 * a})`;
  c.font = `800 ${Math.max(9, r * 0.6)}px 'Outfit', sans-serif`;
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.fillText("JACK", core.sx, core.sy);
  c.textBaseline = "alphabetic";
}
