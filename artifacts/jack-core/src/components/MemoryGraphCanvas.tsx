import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
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
  cullBounds,
  glowVisible,
  gridCellKey,
  gridCoord,
  isOffscreen,
  showTopicMetrics,
  useGridRepulsion,
} from "../lib/graph-perf";
import {
  MemoryGraphPulseController,
  pulseSegment,
} from "../lib/memory-graph-pulse";
import { useSystemHealth } from "../hooks/use-system-health";
import { ambientMotionEnabled } from "../lib/motion";

/**
 * MemoryGraphCanvas — the interactive centerpiece of the Memory Graph view.
 *
 * Renders Jack's living memory as a force-directed, additive-glow constellation:
 * a hexagonal JACK core at the center, color-coded topic hubs on a radial ring,
 * and competency + video nodes clustered around their hub. Supports wheel/pinch
 * zoom (toward the cursor), drag-to-pan, hover highlighting, and click-to-select
 * (lifted to React for the inspector panels).
 */

export interface MemoryGraphHandle {
  zoomIn: () => void;
  zoomOut: () => void;
  reset: () => void;
  /**
   * Project a node's *current* world position to screen (CSS px, relative to
   * the canvas) so React can anchor a popover to it and follow it live as the
   * simulation drifts or the camera pans/zooms. Returns null if the node is gone.
   */
  getScreenPos: (id: string) => { x: number; y: number; r: number } | null;
  /**
   * Pan (and gently zoom in if very zoomed out) so the node sits at the center
   * of the stage. Used by search Enter-to-jump; single-click selection never
   * moves the camera.
   */
  focusNode: (id: string) => void;
  /**
   * Smoothly pan the node into a comfortable viewing area ONLY if it currently
   * sits too close to an edge (behind the header/inspector); a no-op when the
   * node is already well-framed, so single-click selection rarely nudges the
   * camera. The pan is eased over several frames, never a hard jump.
   */
  ensureVisible: (id: string) => void;
}

interface Props {
  model: GraphModel;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onHover?: (id: string | null) => void;
  /** Double-click a node to toggle its pinned (parked-in-place) state. */
  onTogglePin?: (id: string) => void;
  /** Ids the user has pinned; pinned nodes stop drifting and get a marker. */
  pinnedIds?: Set<string>;
  search: string;
  /** Currently-highlighted search result (arrow-key navigation cursor). */
  activeMatchId?: string | null;
  locked: boolean;
  /** Per-poll snapshot diff — drives node births + edge-strengthen pulses. */
  delta?: GraphDelta | null;
  onZoomChange: (pct: number) => void;
}

interface P {
  id: string;
  kind: NodeKind;
  label: string;
  color: RGB;
  status?: string;
  topicId?: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  /** Knowledge-weighted target radius; `radius` eases toward this each frame. */
  targetRadius: number;
  /** Topic hubs with no real captured content yet render as invitations. */
  populated: boolean;
  bornAt: number;
  // Topic hubs orbit a fixed radial anchor; others spring to their hub.
  anchorX?: number;
  anchorY?: number;
}

const BASE_RADII: Record<NodeKind, number> = {
  core: 26,
  topic: 9,
  video: 5,
  mentor: 5.5,
  contributor: 5.5,
  competency: 3.4,
  concept: 3.2,
  tool: 3.2,
  equipment: 3.2,
  material: 3.2,
  procedure: 3.2,
  hazard: 3.2,
  slang: 3.2,
  certification: 3.2,
  standard: 3.2,
  regional_term: 3.2,
};

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Node radius scaled by *accumulated knowledge*. Atomic-knowledge nodes grow
 * with corroboration (how many videos teach them) and confidence; scaffold
 * nodes grow with their connection count so busy hubs read larger.
 */
function nodeRadius(n: MemoryNode, degree: number): number {
  const base = BASE_RADII[n.kind] ?? 3.2;
  if (n.kind === "core") return base;
  let weight = 0;
  if (isKnowledgeKind(n.kind)) {
    const sources = n.meta.sourceCount ?? 1;
    const confidence = n.meta.confidence ?? 0.5;
    weight = clamp01(0.55 * clamp01(sources / 5) + 0.45 * clamp01(confidence));
  } else if (n.kind === "topic") {
    weight = clamp01(degree / 40);
  } else {
    weight = clamp01(degree / 10);
  }
  return base * (1 + weight * 1.3);
}

/** How long a node's birth glow burst and an edge's strengthen pulse last (ms). */
const BIRTH_MS = 1600;
const STRENGTHEN_MS = 1100;

const REPULSION = 1600;
const DAMP = 0.86;
const DRIFT = 0.04;
const MAX_SPEED = 3.2;
const MIN_SCALE = 0.35;
const MAX_SCALE = 3;

/** Stable empty set so an omitted `pinnedIds` prop never re-triggers effects. */
const EMPTY_PINNED: Set<string> = new Set();

/**
 * Neural-flow pulse color per Systems Health state. Green is both "healthy /
 * idle" and the fallback when no state is detected (offline / unknown).
 */
const PULSE_STATE_RGB: Record<string, RGB> = {
  green: [110, 231, 183], // healthy / idle
  purple: [167, 139, 250], // reasoning
  orange: [251, 146, 60], // learning / memory write
  red: [248, 113, 113], // error
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

export const MemoryGraphCanvas = forwardRef<MemoryGraphHandle, Props>(
  function MemoryGraphCanvas(
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
    },
    ref,
  ) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const nodesRef = useRef<Map<string, P>>(new Map());
    const edgesRef = useRef(model.edges);
    const edgeBornRef = useRef<Map<string, number>>(new Map());
    // Birth glow bursts (nodeId → stamp) and edge-strengthen pulses (edgeKey →
    // stamp), populated from the shared delta and consumed by the draw loop.
    const birthGlowRef = useRef<Map<string, number>>(new Map());
    const strengthenRef = useRef<Map<string, number>>(new Map());
    const lockedRef = useRef(locked);
    const adjacencyRef = useRef<Map<string, Set<string>>>(new Map());
    const topicsRef = useRef(model.topics);
    const sizeRef = useRef({ w: 1, h: 1, dpr: 1 });
    const camRef = useRef({ scale: 1, tx: 0, ty: 0 });
    // Pending eased pan target (world-independent screen translation). Set by
    // ensureVisible, consumed + cleared by the frame loop; any user-driven camera
    // move (drag/wheel/zoom/reset/focus) cancels it so it never fights the user.
    const camTargetRef = useRef<{ tx: number; ty: number } | null>(null);
    const reducedRef = useRef(false);
    const selectedRef = useRef<string | null>(selectedId);
    const searchRef = useRef("");
    const activeMatchRef = useRef<string | null>(null);
    const hoverRef = useRef<string | null>(null);
    const starsRef = useRef<{ x: number; y: number; r: number; a: number }[]>([]);
    // Per-color pre-rasterized radial-glow sprites, blitted with drawImage in the
    // node-glow pass instead of building a gradient + filling a large arc per node
    // per frame — the dominant cost that stalls a dense graph at full zoom. Scoped
    // to the instance so it is released on unmount; bounded by the color palette.
    const glowSpritesRef = useRef<Map<string, HTMLCanvasElement>>(new Map());
    // Pinned ids + latest callbacks kept in refs so the (locked-only) sim effect
    // always sees current values without re-subscribing its listeners each render.
    const pinnedRef = useRef<Set<string>>(EMPTY_PINNED);
    const onHoverRef = useRef(onHover);
    const onTogglePinRef = useRef(onTogglePin);

    selectedRef.current = selectedId;
    lockedRef.current = locked;
    searchRef.current = search.trim().toLowerCase();
    activeMatchRef.current = activeMatchId ?? null;
    pinnedRef.current = pinnedIds ?? EMPTY_PINNED;
    onHoverRef.current = onHover;
    onTogglePinRef.current = onTogglePin;

    // ----- neural flow ("thinking") ----------------------------------------
    // A live pulse controller drives ambient Core → hub → cluster pulses. Its
    // color follows the shared Systems Health snapshot (deduped with the
    // heartbeat widget), defaulting to green when offline / no state is known.
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

    // ----- imperative zoom controls (wired to the on-screen buttons) --------
    const applyZoom = (factor: number, cx?: number, cy?: number) => {
      camTargetRef.current = null;
      const cam = camRef.current;
      const { w, h } = sizeRef.current;
      const px = cx ?? w / 2;
      const py = cy ?? h / 2;
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, cam.scale * factor));
      // Keep the world point under (px,py) fixed while zooming.
      const wx = (px - cam.tx) / cam.scale;
      const wy = (py - cam.ty) / cam.scale;
      cam.scale = next;
      cam.tx = px - wx * next;
      cam.ty = py - wy * next;
      onZoomChange(Math.round(next * 100));
    };

    useImperativeHandle(ref, () => ({
      zoomIn: () => applyZoom(1.2),
      zoomOut: () => applyZoom(1 / 1.2),
      reset: () => {
        camTargetRef.current = null;
        const cam = camRef.current;
        cam.scale = 1;
        cam.tx = 0;
        cam.ty = 0;
        onZoomChange(100);
      },
      getScreenPos: (id: string) => {
        const n = nodesRef.current.get(id);
        if (!n) return null;
        const cam = camRef.current;
        return {
          x: n.x * cam.scale + cam.tx,
          y: n.y * cam.scale + cam.ty,
          r: n.radius * cam.scale,
        };
      },
      focusNode: (id: string) => {
        camTargetRef.current = null;
        const n = nodesRef.current.get(id);
        if (!n) return;
        const cam = camRef.current;
        const { w, h } = sizeRef.current;
        // Gently zoom in if the user was scanning from far out, but never zoom
        // back out — jumping should reveal the node, not disrupt their framing.
        const scale = Math.min(MAX_SCALE, Math.max(cam.scale, 1.15));
        cam.scale = scale;
        cam.tx = w / 2 - n.x * scale;
        cam.ty = h / 2 - n.y * scale;
        onZoomChange(Math.round(scale * 100));
      },
      ensureVisible: (id: string) => {
        const n = nodesRef.current.get(id);
        if (!n) return;
        const cam = camRef.current;
        const { w, h } = sizeRef.current;
        const sx = n.x * cam.scale + cam.tx;
        const sy = n.y * cam.scale + cam.ty;
        const margin = Math.min(w, h) * 0.18;
        // The top edge is busier (header + breadcrumb overlay), so keep a larger
        // clearance there than the other three sides.
        const topMargin = Math.max(margin, 96);
        let tx = cam.tx;
        let ty = cam.ty;
        if (sx < margin) tx += margin - sx;
        else if (sx > w - margin) tx -= sx - (w - margin);
        if (sy < topMargin) ty += topMargin - sy;
        else if (sy > h - margin) ty -= sy - (h - margin);
        // Already comfortably framed — don't nudge the camera at all.
        if (Math.abs(tx - cam.tx) < 0.5 && Math.abs(ty - cam.ty) < 0.5) return;
        camTargetRef.current = { tx, ty };
      },
    }));

    // ----- (re)build node set whenever the model changes ---------------------
    useEffect(() => {
      edgesRef.current = model.edges;
      topicsRef.current = model.topics;

      const adj = new Map<string, Set<string>>();
      for (const e of model.edges) {
        if (!adj.has(e.a)) adj.set(e.a, new Set());
        if (!adj.has(e.b)) adj.set(e.b, new Set());
        adj.get(e.a)!.add(e.b);
        adj.get(e.b)!.add(e.a);
      }
      adjacencyRef.current = adj;

      // Derive the neural-flow topology from the LIVE graph (never hardcoded to
      // specific trades): hubs are the topic cluster-heads bridged to the core,
      // and a hub's members are its non-core, non-topic neighbors. New clusters
      // therefore light up automatically as the graph grows.
      const topicIds = new Set(model.topics.map((t) => t.id));
      const coreNeighbors = adj.get(CORE_ID);
      const hubIds: string[] = [];
      const membersByHub: Record<string, string[]> = {};
      for (const t of model.topics) {
        if (!coreNeighbors?.has(t.id)) continue;
        hubIds.push(t.id);
        const members: string[] = [];
        for (const nb of adj.get(t.id) ?? []) {
          if (nb === CORE_ID || topicIds.has(nb)) continue;
          members.push(nb);
        }
        membersByHub[t.id] = members;
      }
      pulseCtrlRef.current?.setTopology({
        coreId: CORE_ID,
        hubIds,
        membersByHub,
      });

      // Measure the canvas directly so layout is correct even when we mount
      // with already-cached data (before the ResizeObserver first fires).
      const canvas = canvasRef.current;
      if (canvas) {
        const rect = canvas.getBoundingClientRect();
        if (rect.width > 1 && rect.height > 1) {
          sizeRef.current = { ...sizeRef.current, w: rect.width, h: rect.height };
        }
      }

      const { w, h } = sizeRef.current;
      const cx = w / 2;
      const cy = h / 2;
      const now = performance.now();
      const map = nodesRef.current;

      const topics = model.topics;
      const modelNodeById = new Map(model.nodes.map((n) => [n.id, n]));
      const topicPopulated = new Map(
        topics.map((t) => [
          t.id,
          t.metrics.knowledge +
            t.metrics.videos +
            t.metrics.conversations +
            (modelNodeById.get(t.id)?.meta.knowledgeObjectCount ?? 0) >
            0,
        ]),
      );
      const ringR = Math.min(w, h) * 0.32;
      const anchorByTopic = new Map<string, { x: number; y: number }>();
      topics.forEach((t, i) => {
        const ang = (i / Math.max(1, topics.length)) * Math.PI * 2 - Math.PI / 2;
        anchorByTopic.set(t.id, {
          x: cx + Math.cos(ang) * ringR,
          y: cy + Math.sin(ang) * ringR,
        });
      });

      const desired = new Set<string>();
      for (const n of model.nodes) {
        desired.add(n.id);
        const target = nodeRadius(n, model.degree[n.id] ?? 0);
        const existing = map.get(n.id);
        if (existing) {
          existing.label = n.label;
          existing.color = n.color;
          existing.status = n.status;
          existing.topicId = n.topicId;
          existing.kind = n.kind;
          existing.populated = n.kind !== "topic" || (topicPopulated.get(n.id) ?? true);
          // Ease toward the new size in step(); corroboration growth animates.
          existing.targetRadius = target;
          if (n.kind === "topic") {
            const a = anchorByTopic.get(n.id);
            if (a) {
              existing.anchorX = a.x;
              existing.anchorY = a.y;
            }
          }
          continue;
        }
        const node = makeNode(n, anchorByTopic, cx, cy, map, now);
        node.radius = target;
        node.targetRadius = target;
        node.populated = n.kind !== "topic" || (topicPopulated.get(n.id) ?? true);
        map.set(n.id, node);
      }
      for (const id of [...map.keys()]) {
        if (!desired.has(id)) map.delete(id);
      }

      // Track edge births so freshly-added connections can draw/fade in.
      const born = edgeBornRef.current;
      const liveEdgeKeys = new Set<string>();
      for (const e of model.edges) {
        const key = `${e.a}->${e.b}:${e.kind}`;
        liveEdgeKeys.add(key);
        if (!born.has(key)) born.set(key, now);
      }
      for (const key of [...born.keys()]) {
        if (!liveEdgeKeys.has(key)) born.delete(key);
      }
    }, [model]);

    // Stamp birth bursts + edge-strengthen pulses from the shared snapshot diff.
    // Declared after the build effect so new nodes already exist in nodesRef.
    // Suppressed entirely when the view is locked or the user prefers reduced
    // motion, so opting out of motion truly means no new motion.
    useEffect(() => {
      if (!delta) return;
      const reduced = !ambientMotionEnabled();
      if (reduced || lockedRef.current) return;
      if (!delta.addedNodeIds.length && !delta.strengthenedEdgeKeys.length) return;
      const now = performance.now();
      for (const id of delta.addedNodeIds) birthGlowRef.current.set(id, now);
      for (const key of delta.strengthenedEdgeKeys)
        strengthenRef.current.set(key, now);
    }, [delta]);

    // ----- render + simulation loop -----------------------------------------
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      reducedRef.current = !ambientMotionEnabled();
      // Neural flow is ambient motion: suppress it under reduced-motion or a
      // locked view, mirroring how birth / edge-strengthen bursts are gated.
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

      // Re-anchor topic hubs whenever the canvas size changes so they don't
      // stay collapsed near the origin after a resize/remount.
      const layoutTopics = (w: number, h: number) => {
        const topics = topicsRef.current;
        const cx = w / 2;
        const cy = h / 2;
        const ringR = Math.min(w, h) * 0.32;
        topics.forEach((t, i) => {
          const ang =
            (i / Math.max(1, topics.length)) * Math.PI * 2 - Math.PI / 2;
          const node = nodesRef.current.get(t.id);
          if (node) {
            node.anchorX = cx + Math.cos(ang) * ringR;
            node.anchorY = cy + Math.sin(ang) * ringR;
          }
        });
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
        const core = nodesRef.current.get(CORE_ID);
        if (core) {
          core.x = w / 2;
          core.y = h / 2;
        }
        layoutTopics(w, h);
      };
      resize();
      const ro = new ResizeObserver(resize);
      ro.observe(canvas);

      const screenToWorld = (sx: number, sy: number) => {
        const cam = camRef.current;
        return { x: (sx - cam.tx) / cam.scale, y: (sy - cam.ty) / cam.scale };
      };

      const pick = (sx: number, sy: number): P | null => {
        const { x, y } = screenToWorld(sx, sy);
        let best: P | null = null;
        let bestD = Infinity;
        for (const n of nodesRef.current.values()) {
          const dx = n.x - x;
          const dy = n.y - y;
          const d = Math.hypot(dx, dy);
          const hit = n.radius + 8 / camRef.current.scale;
          if (d < hit && d < bestD) {
            best = n;
            bestD = d;
          }
        }
        return best;
      };

      // ----- pointer interaction --------------------------------------------
      // Supports mouse drag-to-pan/click-to-select, wheel-zoom, double-click-to-pin
      // (desktop) AND two-finger pinch-to-zoom + long-press-to-pin (touch), all on
      // the same pointer-event stream so a phone with a trackpad-like touchscreen
      // gets consistent behavior.
      let dragging = false;
      let moved = 0;
      let last = { x: 0, y: 0 };
      let dragPointerType: string = "mouse";
      let longPressFired = false;
      let longPressTimer: ReturnType<typeof setTimeout> | null = null;
      const activePointers = new Map<number, { x: number; y: number }>();
      let pinchStartDist = 0;
      let pinchStartScale = 1;
      let pinchMid = { x: 0, y: 0 };

      const clearLongPress = () => {
        if (longPressTimer) {
          clearTimeout(longPressTimer);
          longPressTimer = null;
        }
      };

      const localXY = (e: PointerEvent) => {
        const rect = canvas.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
      };

      const dist2 = (a: { x: number; y: number }, b: { x: number; y: number }) =>
        Math.hypot(a.x - b.x, a.y - b.y);

      const onPointerDown = (e: PointerEvent) => {
        if (locked) return;
        camTargetRef.current = null;
        const pos = localXY(e);
        activePointers.set(e.pointerId, pos);
        try {
          canvas.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }

        if (activePointers.size === 2) {
          // Second finger down — switch into pinch-zoom, abandoning any
          // single-finger drag/long-press that was in flight.
          dragging = false;
          clearLongPress();
          const pts = [...activePointers.values()];
          pinchStartDist = dist2(pts[0]!, pts[1]!);
          pinchStartScale = camRef.current.scale;
          pinchMid = { x: (pts[0]!.x + pts[1]!.x) / 2, y: (pts[0]!.y + pts[1]!.y) / 2 };
          return;
        }
        if (activePointers.size > 2) return;

        dragging = true;
        moved = 0;
        last = pos;
        dragPointerType = e.pointerType;

        // Touch has no hover/double-click, so a long-press is the touch-native
        // equivalent of desktop's double-click-to-pin.
        if (e.pointerType === "touch") {
          longPressFired = false;
          clearLongPress();
          longPressTimer = setTimeout(() => {
            if (!dragging || moved > 10) return;
            const hit = pick(pos.x, pos.y);
            if (hit && hit.kind !== "core") {
              longPressFired = true;
              onTogglePinRef.current?.(hit.id);
              dragging = false;
            }
          }, 550);
        }
      };
      const onPointerMove = (e: PointerEvent) => {
        const pos = localXY(e);
        if (activePointers.has(e.pointerId)) activePointers.set(e.pointerId, pos);

        if (activePointers.size === 2 && !locked) {
          const pts = [...activePointers.values()];
          const d = dist2(pts[0]!, pts[1]!);
          if (pinchStartDist > 1) {
            const factor = d / pinchStartDist;
            const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, pinchStartScale * factor));
            const cam = camRef.current;
            const wx = (pinchMid.x - cam.tx) / cam.scale;
            const wy = (pinchMid.y - cam.ty) / cam.scale;
            cam.scale = next;
            cam.tx = pinchMid.x - wx * next;
            cam.ty = pinchMid.y - wy * next;
            onZoomChange(Math.round(next * 100));
          }
          return;
        }

        const { x, y } = pos;
        if (dragging && !locked) {
          const dx = x - last.x;
          const dy = y - last.y;
          moved += Math.abs(dx) + Math.abs(dy);
          if (moved > 10) clearLongPress();
          camRef.current.tx += dx;
          camRef.current.ty += dy;
          last = { x, y };
        } else {
          const hit = pick(x, y);
          const id = hit?.id ?? null;
          if (id !== hoverRef.current) {
            hoverRef.current = id;
            onHoverRef.current?.(id);
            canvas.style.cursor = id ? "pointer" : locked ? "default" : "grab";
          }
        }
      };
      const onPointerUp = (e: PointerEvent) => {
        activePointers.delete(e.pointerId);
        clearLongPress();
        if (locked) return;
        if (activePointers.size >= 1) {
          // Lifting one finger out of a pinch — reset so the remaining finger
          // resumes a fresh pan instead of jumping to the old drag delta.
          dragging = false;
          return;
        }
        const { x, y } = localXY(e);
        const clickThreshold = dragPointerType === "touch" ? 10 : 6;
        if (dragging && moved < clickThreshold && !longPressFired) {
          const hit = pick(x, y);
          onSelect(hit ? hit.id : null);
        }
        dragging = false;
        try {
          canvas.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      };
      const onPointerCancel = (e: PointerEvent) => {
        activePointers.delete(e.pointerId);
        clearLongPress();
        dragging = false;
      };
      const onWheel = (e: WheelEvent) => {
        if (locked) return;
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        applyZoom(factor, e.clientX - rect.left, e.clientY - rect.top);
      };
      const onLeave = () => {
        if (hoverRef.current !== null) {
          hoverRef.current = null;
          onHoverRef.current?.(null);
        }
      };
      // Double-click pins/unpins the node under the cursor so it stops drifting.
      const onDblClick = (e: MouseEvent) => {
        if (locked) return;
        const rect = canvas.getBoundingClientRect();
        const hit = pick(e.clientX - rect.left, e.clientY - rect.top);
        if (hit && hit.kind !== "core") onTogglePinRef.current?.(hit.id);
      };

      canvas.addEventListener("pointerdown", onPointerDown);
      canvas.addEventListener("pointermove", onPointerMove);
      canvas.addEventListener("pointerup", onPointerUp);
      canvas.addEventListener("pointercancel", onPointerCancel);
      canvas.addEventListener("pointerleave", onLeave);
      canvas.addEventListener("dblclick", onDblClick);
      canvas.addEventListener("wheel", onWheel, { passive: false });

      // ----- simulation ------------------------------------------------------
      const step = (dt: number) => {
        const nodes = [...nodesRef.current.values()];
        const map = nodesRef.current;
        const reduced = reducedRef.current;
        const n = nodes.length;

        // Pairwise repulsion (capped — current data is comfortably under this).
        if (!useGridRepulsion(n)) {
          for (let i = 0; i < n; i++) {
            const a = nodes[i]!;
            if (a.kind === "core") continue;
            for (let j = i + 1; j < n; j++) {
              const b = nodes[j]!;
              if (b.kind === "core") continue;
              let dx = a.x - b.x;
              let dy = a.y - b.y;
              let d2 = dx * dx + dy * dy;
              if (d2 < 0.01) {
                dx = Math.random() - 0.5;
                dy = Math.random() - 0.5;
                d2 = 0.01;
              }
              // Same-hub nodes repel a little less so clusters stay tight.
              const sameHub = a.topicId && a.topicId === b.topicId;
              const force = (REPULSION * (sameHub ? 0.5 : 1)) / d2;
              const d = Math.sqrt(d2);
              const fx = (dx / d) * force;
              const fy = (dy / d) * force;
              a.vx += fx;
              a.vy += fy;
              b.vx -= fx;
              b.vy -= fy;
            }
          }
        } else {
          // Large graph: fall back to spatial-grid repulsion so cost stays near
          // O(n) instead of O(n²). Each node only feels neighbors in its own and
          // adjacent cells; force is applied to `p` alone (the symmetric partner
          // gets its own pass), which avoids per-pair dedup bookkeeping.
          const grid = new Map<number, P[]>();
          for (const p of nodes) {
            if (p.kind === "core") continue;
            const k = gridCellKey(gridCoord(p.x), gridCoord(p.y));
            const arr = grid.get(k);
            if (arr) arr.push(p);
            else grid.set(k, [p]);
          }
          for (const p of nodes) {
            if (p.kind === "core") continue;
            const gx = gridCoord(p.x);
            const gy = gridCoord(p.y);
            for (let ox = -1; ox <= 1; ox++) {
              for (let oy = -1; oy <= 1; oy++) {
                const arr = grid.get(gridCellKey(gx + ox, gy + oy));
                if (!arr) continue;
                for (const b of arr) {
                  if (b === p || b.kind === "core") continue;
                  let dx = p.x - b.x;
                  let dy = p.y - b.y;
                  let d2 = dx * dx + dy * dy;
                  if (d2 < 0.01) {
                    dx = Math.random() - 0.5;
                    dy = Math.random() - 0.5;
                    d2 = 0.01;
                  }
                  const sameHub = p.topicId && p.topicId === b.topicId;
                  const force = (REPULSION * (sameHub ? 0.5 : 1)) / d2;
                  const d = Math.sqrt(d2);
                  p.vx += (dx / d) * force;
                  p.vy += (dy / d) * force;
                }
              }
            }
          }
        }

        for (const node of nodes) {
          if (node.kind === "core") {
            node.vx = 0;
            node.vy = 0;
            continue;
          }
          // Pinned nodes stay exactly where the user parked them (double-click).
          if (pinnedRef.current.has(node.id)) {
            node.vx = 0;
            node.vy = 0;
            continue;
          }
          if (node.kind === "topic" && node.anchorX != null && node.anchorY != null) {
            node.vx += (node.anchorX - node.x) * 0.02;
            node.vy += (node.anchorY - node.y) * 0.02;
          } else if (node.topicId) {
            const hub = map.get(node.topicId);
            if (hub) {
              node.vx += (hub.x - node.x) * 0.012;
              node.vy += (hub.y - node.y) * 0.012;
            }
          } else {
            const core = map.get(CORE_ID);
            if (core) {
              node.vx += (core.x - node.x) * 0.004;
              node.vy += (core.y - node.y) * 0.004;
            }
          }
          if (!reduced) {
            node.vx += (Math.random() - 0.5) * DRIFT;
            node.vy += (Math.random() - 0.5) * DRIFT;
          }
          node.vx *= DAMP;
          node.vy *= DAMP;
          const sp = Math.hypot(node.vx, node.vy);
          if (sp > MAX_SPEED) {
            node.vx = (node.vx / sp) * MAX_SPEED;
            node.vy = (node.vy / sp) * MAX_SPEED;
          }
          node.x += node.vx * dt;
          node.y += node.vy * dt;
          // Ease the rendered radius toward its knowledge-weighted target so
          // corroboration growth (and shrink-back) animates smoothly.
          if (node.radius !== node.targetRadius) {
            node.radius += (node.targetRadius - node.radius) * Math.min(1, 0.08 * dt);
            if (Math.abs(node.targetRadius - node.radius) < 0.02) {
              node.radius = node.targetRadius;
            }
          }
        }
      };

      // ----- drawing ---------------------------------------------------------
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

        // Faint static starfield for depth (decorative, not data).
        ctx.save();
        for (const s of starsRef.current) {
          ctx.fillStyle = `rgba(180, 200, 255, ${s.a})`;
          ctx.fillRect(s.x, s.y, s.r, s.r);
        }
        ctx.restore();

        // World transform for everything graph-related.
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.translate(cam.tx, cam.ty);
        ctx.scale(cam.scale, cam.scale);

        // Viewport bounds in WORLD space, padded to cover glow radius, so we can
        // skip anything off-screen. Keeps large graphs cheap when zoomed in.
        const bounds = cullBounds(cam, w, h);
        const offscreen = (n: P): boolean => isOffscreen(n.x, n.y, bounds);

        const related =
          sel && adj.has(sel) ? (adj.get(sel) as Set<string>) : null;
        const dimmed = (id: string, topicId?: string): boolean => {
          if (q) {
            const node = map.get(id);
            const match =
              node && node.label.toLowerCase().includes(q);
            return !match;
          }
          if (sel) return id !== sel && !(related?.has(id) ?? false);
          return false;
        };

        // Topic nebula halos (additive) — make even sparse hubs read as clusters.
        ctx.globalCompositeOperation = "lighter";
        for (const t of topicsRef.current) {
          const hub = map.get(t.id);
          if (!hub) continue;
          const haloR = 120;
          const g = ctx.createRadialGradient(hub.x, hub.y, 0, hub.x, hub.y, haloR);
          const fade = dimmed(t.id) ? 0.04 : 0.12;
          g.addColorStop(0, rgba(t.color, fade));
          g.addColorStop(1, rgba(t.color, 0));
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(hub.x, hub.y, haloR, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalCompositeOperation = "source-over";

        // Edges.
        const bornMap = edgeBornRef.current;
        const strengthenMap = strengthenRef.current;
        for (const e of edgesRef.current) {
          const a = map.get(e.a);
          const b = map.get(e.b);
          if (!a || !b) continue;
          if (offscreen(a) && offscreen(b)) continue;
          const isSel =
            sel && (e.a === sel || e.b === sel);
          const faded = dimmed(e.a, a.topicId) && dimmed(e.b, b.topicId);
          const col = b.color;
          // Provenance (video -> knowledge) edges get a touch more presence so
          // the atomic-knowledge web is legible against the scaffold.
          let alpha =
            e.kind === "competency" ? 0.08 : e.kind === "knowledge" ? 0.16 : 0.14;
          if (isSel) alpha = 0.55;
          else if (faded) alpha = 0.03;
          // Fade freshly-added connections in, and grow the line toward the target.
          const key = `${e.a}->${e.b}:${e.kind}`;
          const bornAt = bornMap.get(key);
          const grow = bornAt == null ? 1 : Math.min(1, (time - bornAt) / 700);
          // A recently-strengthened edge (corroboration weight rose) pulses
          // brighter + thicker, then settles — reinforcement reads as "alive".
          let boost = 0;
          const strAt = strengthenMap.get(key);
          if (strAt != null) {
            const sp = (time - strAt) / STRENGTHEN_MS;
            if (sp >= 1) strengthenMap.delete(key);
            else boost = (1 - sp) * (0.5 + 0.5 * Math.sin(time * 0.02));
          }
          ctx.strokeStyle = rgba(col, Math.min(0.85, (alpha + boost * 0.5) * grow));
          ctx.lineWidth = ((isSel ? 1.4 : 0.7) + boost * 1.8) / cam.scale;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(a.x + (b.x - a.x) * grow, a.y + (b.y - a.y) * grow);
          ctx.stroke();
        }

        // Node glows (additive). Selected + active search match get a pulsing,
        // emphasized glow so relationships (and the search cursor) pop.
        ctx.globalCompositeOperation = "lighter";
        const birthMap = birthGlowRef.current;
        for (const node of map.values()) {
          if (node.kind === "core") continue;
          if (offscreen(node)) continue;
          const emphasized = node.id === sel || node.id === active;
          // LOD: when zoomed far out, skip the (costly) additive glow on small,
          // unremarkable nodes — hubs and emphasized nodes always keep theirs.
          if (!glowVisible(cam.scale, node.kind, emphasized)) continue;
          drawNodeGlow(
            ctx,
            node,
            time,
            dimmed(node.id, node.topicId),
            emphasized,
            glowSpritesRef.current,
          );
          // Organic birth burst for a genuinely-new node: an expanding halo +
          // brief flare that decays out over BIRTH_MS.
          const bAt = birthMap.get(node.id);
          if (bAt != null) {
            const bp = (time - bAt) / BIRTH_MS;
            if (bp >= 1) birthMap.delete(node.id);
            else drawBirthBurst(ctx, node, bp);
          }
        }
        ctx.globalCompositeOperation = "source-over";

        // Crisp node bodies + selection/hover/active rings.
        for (const node of map.values()) {
          if (node.kind === "core") continue;
          if (offscreen(node)) continue;
          drawNodeBody(
            ctx,
            node,
            time,
            cam.scale,
            dimmed(node.id, node.topicId),
            node.id === sel,
            node.id === hoverRef.current,
            pinnedRef.current.has(node.id),
            node.id === active,
          );
        }

        // Neural-flow pulses (ambient "thinking"): a draw-only overlay in world
        // space, so it rides pan/zoom and never touches pointer handling. Each
        // pulse is resolved against LIVE node positions every frame, so it stays
        // glued to nodes as the simulation drifts.
        const pulseCtrl = pulseCtrlRef.current;
        if (pulseCtrl && pulseCtrl.hasActivity()) {
          const pcol = pulseCtrl.getColor();
          ctx.globalCompositeOperation = "lighter";
          ctx.lineCap = "round";
          for (const p of pulseCtrl.getPulses()) {
            const a = map.get(p.fromId);
            const b = map.get(p.toId);
            if (!a || !b) continue;
            if (offscreen(a) && offscreen(b)) continue;
            const isPrimary = p.kind === "primary";
            // A short trailing comet toward where it came from reads as a signal
            // moving through the network rather than a static blinking dot.
            // Resolve it through the guarded geometry helper: a degenerate
            // segment (non-finite node position, or a coincident head/tail at
            // t=0 / on a zero-length edge) returns null and draws nothing, so
            // createLinearGradient can never spike into a canvas-spanning line.
            const seg = pulseSegment(
              a.x,
              a.y,
              b.x,
              b.y,
              p.t,
              isPrimary ? 0.16 : 0.11,
            );
            if (!seg) continue;
            const { tx, ty, hx, hy } = seg;
            const trail = ctx.createLinearGradient(tx, ty, hx, hy);
            trail.addColorStop(0, rgba(pcol, 0));
            trail.addColorStop(1, rgba(pcol, isPrimary ? 0.5 : 0.32));
            ctx.strokeStyle = trail;
            ctx.lineWidth = (isPrimary ? 2.2 : 1.4) / cam.scale;
            ctx.beginPath();
            ctx.moveTo(tx, ty);
            ctx.lineTo(hx, hy);
            ctx.stroke();
            // Soft glowing head.
            const headR = isPrimary ? 3.4 : 2.1;
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

        // Topic labels.
        ctx.textAlign = "center";
        for (const t of topicsRef.current) {
          const hub = map.get(t.id);
          if (!hub) continue;
          const faded = dimmed(t.id);
          ctx.font = `700 ${11 / cam.scale}px 'Space Mono', monospace`;
          ctx.fillStyle = rgba([235, 240, 255], faded ? 0.25 : 0.85);
          ctx.fillText(
            t.label.toUpperCase(),
            hub.x,
            hub.y - hub.radius - 10 / cam.scale,
          );
          if (!hub.populated) {
            ctx.font = `500 ${8.5 / cam.scale}px 'Space Mono', monospace`;
            ctx.fillStyle = rgba([255, 170, 90], faded ? 0.3 : 0.72);
            ctx.fillText(
              "+ be the first",
              hub.x,
              hub.y + hub.radius + 13 / cam.scale,
            );
          }
          // Cluster composition line under the hub — only when zoomed in enough
          // to read it, so far-out views stay clean.
          if (hub.populated && showTopicMetrics(cam.scale)) {
            const m = t.metrics;
            const parts: string[] = [];
            if (m.knowledge)
              parts.push(`${m.knowledge} concept${m.knowledge === 1 ? "" : "s"}`);
            if (m.videos)
              parts.push(`${m.videos} video${m.videos === 1 ? "" : "s"}`);
            if (m.conversations)
              parts.push(
                `${m.conversations} mentor${m.conversations === 1 ? "" : "s"}`,
              );
            if (parts.length > 0) {
              ctx.font = `500 ${8.5 / cam.scale}px 'Space Mono', monospace`;
              ctx.fillStyle = rgba([200, 214, 245], faded ? 0.18 : 0.5);
              ctx.fillText(
                parts.join("  ·  "),
                hub.x,
                hub.y + hub.radius + 13 / cam.scale,
              );
              // A slim cluster-maturity bar under the composition line so a hub's
              // "how grown-up am I" reads at a glance without opening it.
              if (m.knowledge > 0) {
                const barW = 34 / cam.scale;
                const barH = 2.4 / cam.scale;
                const bx = hub.x - barW / 2;
                const by = hub.y + hub.radius + 20 / cam.scale;
                ctx.fillStyle = rgba([255, 255, 255], faded ? 0.05 : 0.14);
                ctx.fillRect(bx, by, barW, barH);
                ctx.fillStyle = rgba(t.color, faded ? 0.3 : 0.9);
                ctx.fillRect(bx, by, barW * m.maturity, barH);
              }
            }
          }
        }

        // The JACK hexagon core, drawn last so it sits on top.
        const core = map.get(CORE_ID);
        if (core) drawCore(ctx, core, time, cam.scale);
      };

      let raf = 0;
      let lastT = performance.now();
      const frame = (t: number) => {
        // Floor at 0: a first-frame timestamp can precede our performance.now()
        // baseline, and a negative dt would ease node radii backwards (into
        // negative values) and crash the arc draws.
        const dt = Math.min(2, Math.max(0, (t - lastT) / 16.67));
        lastT = t;
        if (!document.hidden) {
          // Ease an in-flight ensureVisible pan toward its target before drawing.
          const target = camTargetRef.current;
          if (target) {
            const cam = camRef.current;
            cam.tx += (target.tx - cam.tx) * 0.14;
            cam.ty += (target.ty - cam.ty) * 0.14;
            if (
              Math.abs(target.tx - cam.tx) < 0.5 &&
              Math.abs(target.ty - cam.ty) < 0.5
            ) {
              cam.tx = target.tx;
              cam.ty = target.ty;
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
        }
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);

      return () => {
        cancelAnimationFrame(raf);
        ro.disconnect();
        clearLongPress();
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointermove", onPointerMove);
        canvas.removeEventListener("pointerup", onPointerUp);
        canvas.removeEventListener("pointercancel", onPointerCancel);
        canvas.removeEventListener("pointerleave", onLeave);
        canvas.removeEventListener("dblclick", onDblClick);
        canvas.removeEventListener("wheel", onWheel);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [locked]);

    return (
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full touch-none"
        style={{ cursor: locked ? "default" : "grab" }}
      />
    );
  },
);

// ---------------------------------------------------------------------------
function makeNode(
  n: MemoryNode,
  anchors: Map<string, { x: number; y: number }>,
  cx: number,
  cy: number,
  map: Map<string, P>,
  now: number,
): P {
  let x = cx;
  let y = cy;
  if (n.kind === "core") {
    x = cx;
    y = cy;
  } else if (n.kind === "topic") {
    const a = anchors.get(n.id);
    if (a) {
      x = a.x;
      y = a.y;
    }
  } else {
    const hub = n.topicId ? map.get(n.topicId) : map.get(CORE_ID);
    const bx = hub?.x ?? cx;
    const by = hub?.y ?? cy;
    const ang = Math.random() * Math.PI * 2;
    const rad = 24 + Math.random() * 46;
    x = bx + Math.cos(ang) * rad;
    y = by + Math.sin(ang) * rad;
  }
  return {
    id: n.id,
    kind: n.kind,
    label: n.label,
    color: n.color,
    status: n.status,
    topicId: n.topicId,
    x,
    y,
    vx: 0,
    vy: 0,
    radius: BASE_RADII[n.kind] ?? 3.2,
    targetRadius: BASE_RADII[n.kind] ?? 3.2,
    populated: n.kind !== "topic" || (n.meta.knowledgeObjectCount ?? 0) > 0,
    bornAt: now,
    anchorX: n.kind === "topic" ? anchors.get(n.id)?.x : undefined,
    anchorY: n.kind === "topic" ? anchors.get(n.id)?.y : undefined,
  };
}

function nodeIntensity(node: P, time: number): number {
  if (node.kind === "video") {
    if (node.status === "failed") return 0.7;
    if (node.status && node.status !== "completed") {
      return 0.5 + 0.5 * (0.5 + 0.5 * Math.sin(time * 0.005 + node.x));
    }
  }
  return 1;
}

/**
 * A one-shot "a new memory just formed" flare: a bright core flash plus an
 * expanding, fading ring. `p` runs 0→1 over the burst's lifetime.
 */
function drawBirthBurst(c: CanvasRenderingContext2D, node: P, p: number) {
  const ease = 1 - (1 - p) * (1 - p); // ease-out
  const col = node.color;
  // Expanding ring.
  const ringR = node.radius * (1.5 + ease * 6);
  c.strokeStyle = rgba(col, (1 - p) * 0.7);
  c.lineWidth = (1 - p) * 2 + 0.4;
  c.beginPath();
  c.arc(node.x, node.y, ringR, 0, Math.PI * 2);
  c.stroke();
  // Bright central flash that fades quickly.
  const flash = Math.max(0, 1 - p * 1.6);
  if (flash > 0) {
    const glowR = node.radius * 4.5;
    const g = c.createRadialGradient(node.x, node.y, 0, node.x, node.y, glowR);
    g.addColorStop(0, rgba(col, 0.75 * flash));
    g.addColorStop(0.5, rgba(col, 0.2 * flash));
    g.addColorStop(1, rgba(col, 0));
    c.fillStyle = g;
    c.beginPath();
    c.arc(node.x, node.y, glowR, 0, Math.PI * 2);
    c.fill();
  }
}

/**
 * Side length (px) of a cached glow sprite. Large enough that scaling it down to
 * a typical node glow stays soft, small enough to build and blit cheaply.
 */
const GLOW_SPRITE_PX = 128;

/**
 * Rasterize one soft radial-glow sprite for `col`. The gradient stops mirror the
 * per-node glow at full intensity (0 → 0.5, 0.4 → 0.12, 1 → 0); the gradient
 * reaches full transparency at the inscribed circle so the square's corners are
 * clear and the blit reads as a circular glow.
 */
function makeGlowSprite(col: RGB): HTMLCanvasElement {
  const size = GLOW_SPRITE_PX;
  const cv = document.createElement("canvas");
  cv.width = size;
  cv.height = size;
  const c = cv.getContext("2d")!;
  const mid = size / 2;
  const g = c.createRadialGradient(mid, mid, 0, mid, mid, mid);
  g.addColorStop(0, rgba(col, 0.5));
  g.addColorStop(0.4, rgba(col, 0.12));
  g.addColorStop(1, rgba(col, 0));
  c.fillStyle = g;
  c.fillRect(0, 0, size, size);
  return cv;
}

/** Get (memoizing) the glow sprite for `col`, keyed by its RGB triple. */
function getGlowSprite(
  cache: Map<string, HTMLCanvasElement>,
  col: RGB,
): HTMLCanvasElement {
  const key = `${col[0]},${col[1]},${col[2]}`;
  let sprite = cache.get(key);
  if (!sprite) {
    sprite = makeGlowSprite(col);
    cache.set(key, sprite);
  }
  return sprite;
}

function drawNodeGlow(
  c: CanvasRenderingContext2D,
  node: P,
  time: number,
  dim: boolean,
  emphasized: boolean,
  sprites: Map<string, HTMLCanvasElement>,
) {
  const age = time - node.bornAt;
  const grow = Math.min(1, age / 600);
  const r = node.radius * (0.4 + 0.6 * grow);
  if (node.kind === "topic" && !node.populated && !emphasized) {
    const breath = 0.5 + 0.5 * Math.sin(time * 0.0018 + node.x * 0.01);
    const idle = (0.12 + 0.06 * breath) * (dim ? 0.4 : 1);
    if (idle <= 0) return;
    const glowR = r * 3.2;
    const sprite = getGlowSprite(sprites, node.color);
    const prevAlpha = c.globalAlpha;
    c.globalAlpha = clamp01(idle);
    c.drawImage(sprite, node.x - glowR, node.y - glowR, glowR * 2, glowR * 2);
    c.globalAlpha = prevAlpha;
    return;
  }
  let intensity = nodeIntensity(node, time) * (dim ? 0.3 : 1);
  let glowR = r * 5;
  const col =
    node.kind === "video" && node.status === "failed"
      ? ([239, 90, 90] as RGB)
      : node.color;

  // Emphasized (selected / active search match) nodes number at most one or two
  // on screen and pulse with an intensity that can exceed 1, so they keep the
  // exact per-frame gradient — pixel-perfect and cheap at that count.
  if (emphasized) {
    // A slow pulse so the focused node reads as "alive" without distracting.
    const pulse = 0.5 + 0.5 * Math.sin(time * 0.006);
    intensity *= 1.35 + 0.55 * pulse;
    glowR *= 1.15 + 0.15 * pulse;
    const g = c.createRadialGradient(node.x, node.y, 0, node.x, node.y, glowR);
    g.addColorStop(0, rgba(col, 0.5 * intensity));
    g.addColorStop(0.4, rgba(col, 0.12 * intensity));
    g.addColorStop(1, rgba(col, 0));
    c.fillStyle = g;
    c.beginPath();
    c.arc(node.x, node.y, glowR, 0, Math.PI * 2);
    c.fill();
    return;
  }

  // Fast path (the crowd): blit the cached glow sprite for this color, scaled to
  // the node's glow diameter, with intensity reapplied via globalAlpha. Under the
  // additive `lighter` composite this matches the gradient it replaces.
  if (glowR <= 0) return;
  const sprite = getGlowSprite(sprites, col);
  const prevAlpha = c.globalAlpha;
  c.globalAlpha = clamp01(intensity);
  c.drawImage(sprite, node.x - glowR, node.y - glowR, glowR * 2, glowR * 2);
  c.globalAlpha = prevAlpha;
}

function drawNodeBody(
  c: CanvasRenderingContext2D,
  node: P,
  time: number,
  scale: number,
  dim: boolean,
  selected: boolean,
  hovered: boolean,
  pinned: boolean,
  active = false,
) {
  const age = time - node.bornAt;
  const grow = Math.min(1, age / 600);
  const r = node.radius * (0.4 + 0.6 * grow);
  // Unrelated nodes fade to ~40% so the selection's neighborhood stands out.
  const intensity = nodeIntensity(node, time) * (dim ? 0.4 : 1);
  const col =
    node.kind === "video" && node.status === "failed"
      ? ([239, 90, 90] as RGB)
      : node.color;

  if (node.kind === "topic" && !node.populated) {
    c.save();
    c.strokeStyle = rgba(col, Math.min(1, 0.6 * intensity + 0.15));
    c.lineWidth = 1.4 / scale;
    c.setLineDash([3.5 / scale, 3 / scale]);
    c.beginPath();
    c.arc(node.x, node.y, r, 0, Math.PI * 2);
    c.stroke();
    c.restore();
  } else {
    c.fillStyle = rgba(col, Math.min(1, 0.8 * intensity + 0.2));
    c.beginPath();
    c.arc(node.x, node.y, r, 0, Math.PI * 2);
    c.fill();
  }

  // Spark-in ring for freshly added nodes.
  if (age < 1500) {
    const p = age / 1500;
    c.strokeStyle = rgba(col, (1 - p) * 0.6);
    c.lineWidth = (1.2 * (1 - p) + 0.3) / scale;
    c.beginPath();
    c.arc(node.x, node.y, Math.max(0, r + p * 40), 0, Math.PI * 2);
    c.stroke();
  }

  // Pulsing halo ring on the selected node — a subtle "you are here" beacon.
  if (selected) {
    const pulse = 0.5 + 0.5 * Math.sin(time * 0.006);
    c.strokeStyle = rgba([255, 255, 255], 0.22 + 0.33 * pulse);
    c.lineWidth = (1 + pulse) / scale;
    c.beginPath();
    c.arc(node.x, node.y, r + (8 + pulse * 6) / scale, 0, Math.PI * 2);
    c.stroke();
  }

  // The active search-result cursor gets its own bright color-matched ring so
  // arrow-key navigation is visible before the user commits with Enter.
  if (active && !selected) {
    const pulse = 0.5 + 0.5 * Math.sin(time * 0.008);
    c.strokeStyle = rgba(col, 0.55 + 0.35 * pulse);
    c.lineWidth = 1.6 / scale;
    c.beginPath();
    c.arc(node.x, node.y, r + (6 + pulse * 5) / scale, 0, Math.PI * 2);
    c.stroke();
  }

  if (selected || hovered) {
    c.strokeStyle = rgba([255, 255, 255], selected ? 0.9 : 0.5);
    c.lineWidth = (selected ? 2 : 1.2) / scale;
    c.beginPath();
    c.arc(node.x, node.y, r + 5 / scale, 0, Math.PI * 2);
    c.stroke();
  }

  // Pinned marker: a dashed ring so a parked node reads as intentionally fixed.
  if (pinned) {
    c.save();
    c.strokeStyle = rgba(col, 0.95);
    c.lineWidth = 1.4 / scale;
    c.setLineDash([3 / scale, 2.5 / scale]);
    c.beginPath();
    c.arc(node.x, node.y, r + 9 / scale, 0, Math.PI * 2);
    c.stroke();
    c.restore();
  }
}

function drawCore(
  c: CanvasRenderingContext2D,
  core: P,
  time: number,
  scale: number,
) {
  const pulse = 1 + 0.05 * Math.sin(time * 0.002);
  const r = core.radius * pulse;

  // Outer additive glow.
  c.globalCompositeOperation = "lighter";
  const glowR = r * 4;
  const g = c.createRadialGradient(core.x, core.y, 0, core.x, core.y, glowR);
  g.addColorStop(0, rgba(core.color, 0.5));
  g.addColorStop(0.5, rgba(core.color, 0.12));
  g.addColorStop(1, rgba(core.color, 0));
  c.fillStyle = g;
  c.beginPath();
  c.arc(core.x, core.y, glowR, 0, Math.PI * 2);
  c.fill();
  c.globalCompositeOperation = "source-over";

  // Hexagon fill + stroke.
  hexPath(c, core.x, core.y, r);
  const fill = c.createRadialGradient(core.x, core.y, 0, core.x, core.y, r);
  fill.addColorStop(0, "rgba(30, 22, 14, 0.95)");
  fill.addColorStop(1, "rgba(14, 12, 18, 0.95)");
  c.fillStyle = fill;
  c.fill();
  c.lineWidth = 2 / scale;
  c.strokeStyle = rgba(core.color, 0.9);
  c.stroke();

  // Inner accent hex.
  hexPath(c, core.x, core.y, r * 0.7);
  c.lineWidth = 1 / scale;
  c.strokeStyle = rgba(core.color, 0.35);
  c.stroke();

  // Label.
  c.fillStyle = "rgba(255, 255, 255, 0.96)";
  c.font = `800 ${15 / scale}px 'Outfit', sans-serif`;
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.fillText("JACK", core.x, core.y);
  c.textBaseline = "alphabetic";
}
