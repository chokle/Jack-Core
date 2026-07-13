import { useEffect, useRef } from "react";
import { useListVideos, getListVideosQueryKey } from "@workspace/api-client-react";
import { IN_FLIGHT_STATUSES } from "@/lib/video-status";
import { ambientMotionEnabled } from "@/lib/motion";

/**
 * KnowledgeGraph — a living, ambient wallpaper that renders Jack's memory as a
 * growing neural constellation behind the entire UI.
 *
 * Hierarchy: a central "JACK" core -> trade hubs -> video neurons -> competency
 * nodes. Every video Jack ingests sprouts a new neuron that sparks into being
 * and is pulled into the web by a lightweight force simulation, so the graph
 * literally grows as the library grows. It is purely decorative
 * (pointer-events: none) and lives on the first layer.
 */

type RawVideo = {
  id: string;
  title?: string;
  trade?: string | null;
  status?: string;
  competencyCodes?: string[] | null;
  competency_codes?: string[] | null;
};

type NodeKind = "core" | "trade" | "video" | "competency";

interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  baseRadius: number;
  status?: string;
  bornAt: number;
  pinned: boolean;
}

interface GraphEdge {
  a: string;
  b: string;
  rest: number;
  strength: number;
  kind: NodeKind;
}

const CORE_ID = "__core__";

type RGB = readonly [number, number, number];
const COL_BG = "rgb(10, 15, 27)";
const COL_PRIMARY: RGB = [255, 102, 0];
const COL_CORE: RGB = [255, 150, 60];
const COL_COMPETENCY: RGB = [126, 169, 222];
const COL_ERROR: RGB = [239, 68, 68];

const RADII: Record<NodeKind, number> = {
  core: 9,
  trade: 5.5,
  video: 3.4,
  competency: 2.4,
};

// Simulation tuning (CSS-pixel space, ~60fps).
const REPULSION = 1400;
const GRAVITY = 0.0009;
const DAMP = 0.88;
const DRIFT = 0.05;
const MAX_SPEED = 3;
const PARALLAX = 0.018;

function rgba(c: RGB, a: number): string {
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;
}

export function KnowledgeGraph() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const nodesRef = useRef<Map<string, GraphNode>>(new Map());
  const edgesRef = useRef<GraphEdge[]>([]);
  // Seed with the real viewport up front: the graph-construction effect runs
  // BEFORE the render-loop effect's resize(), so a {w:1,h:1} seed would spawn
  // every node at (0.5, 0.5). That pile of coincident nodes produces degenerate
  // (zero-length) draw geometry, which Chrome renders as a canvas-spanning
  // gradient spike (the stray blue crosshair) until the sim spreads them out.
  const sizeRef = useRef({
    w: typeof window !== "undefined" ? window.innerWidth || 1 : 1,
    h: typeof window !== "undefined" ? window.innerHeight || 1 : 1,
    dpr: 1,
  });
  const pointerRef = useRef({ x: 0, y: 0 });
  const reducedMotionRef = useRef(false);

  const { data } = useListVideos(
    { limit: 200 },
    {
      query: {
        queryKey: getListVideosQueryKey({ limit: 200 }),
        // Keep the field growing live: faster while anything is processing,
        // slower idle poll to pick up newly ingested memories.
        refetchInterval: (q) => {
          const vids =
            (q.state.data as { videos?: RawVideo[] } | undefined)?.videos ?? [];
          const processing = vids.some((v) => IN_FLIGHT_STATUSES.has(v.status ?? ""));
          return processing ? 4000 : 8000;
        },
      },
    },
  );

  // ---- graph construction ------------------------------------------------
  useEffect(() => {
    const videos = (data?.videos ?? []) as unknown as RawVideo[];
    const now = performance.now();
    const nodes = nodesRef.current;
    const { w, h } = sizeRef.current;

    const makeNode = (
      id: string,
      kind: NodeKind,
      label: string,
      x: number,
      y: number,
      pinned = false,
      status?: string,
    ): GraphNode => ({
      id,
      kind,
      label,
      x,
      y,
      vx: 0,
      vy: 0,
      baseRadius: RADII[kind],
      bornAt: now,
      pinned,
      status,
    });

    const spawnNear = (
      parentId: string,
      id: string,
      kind: NodeKind,
      label: string,
      status?: string,
    ): GraphNode => {
      const p = nodes.get(parentId);
      const bx = p ? p.x : w / 2;
      const by = p ? p.y : h / 2;
      const ang = Math.random() * Math.PI * 2;
      const rad = 20 + Math.random() * 30;
      return makeNode(
        id,
        kind,
        label,
        bx + Math.cos(ang) * rad,
        by + Math.sin(ang) * rad,
        false,
        status,
      );
    };

    if (!nodes.has(CORE_ID)) {
      nodes.set(CORE_ID, makeNode(CORE_ID, "core", "JACK", w / 2, h / 2, true));
    }

    const desired = new Set<string>([CORE_ID]);
    const trades = new Set<string>();
    const comps = new Set<string>();

    for (const v of videos) {
      if (v.trade) trades.add(v.trade);
      const codes = (v.competencyCodes ?? v.competency_codes ?? []) as string[];
      for (const c of codes) comps.add(c);
    }

    for (const t of trades) {
      const id = `trade:${t}`;
      desired.add(id);
      if (!nodes.has(id)) nodes.set(id, spawnNear(CORE_ID, id, "trade", t));
    }

    for (const v of videos) {
      const id = `video:${v.id}`;
      desired.add(id);
      const parentId = v.trade ? `trade:${v.trade}` : CORE_ID;
      const existing = nodes.get(id);
      if (!existing) {
        nodes.set(id, spawnNear(parentId, id, "video", v.title ?? "", v.status));
      } else {
        existing.status = v.status;
      }
    }

    for (const c of comps) {
      const id = `comp:${c}`;
      desired.add(id);
      if (!nodes.has(id)) nodes.set(id, spawnNear(CORE_ID, id, "competency", c));
    }

    for (const id of [...nodes.keys()]) {
      if (!desired.has(id)) nodes.delete(id);
    }

    const edges: GraphEdge[] = [];
    for (const t of trades) {
      edges.push({ a: CORE_ID, b: `trade:${t}`, rest: 150, strength: 0.02, kind: "trade" });
    }
    for (const v of videos) {
      const vid = `video:${v.id}`;
      const parentId = v.trade ? `trade:${v.trade}` : CORE_ID;
      edges.push({ a: parentId, b: vid, rest: 85, strength: 0.03, kind: "video" });
      const codes = (v.competencyCodes ?? v.competency_codes ?? []) as string[];
      for (const c of codes) {
        edges.push({ a: vid, b: `comp:${c}`, rest: 55, strength: 0.025, kind: "competency" });
      }
    }
    edgesRef.current = edges;
  }, [data]);

  // ---- render loop -------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctxRef.current = ctx;
    reducedMotionRef.current = !ambientMotionEnabled();

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = window.innerWidth;
      const h = window.innerHeight;
      sizeRef.current = { w, h, dpr };
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      const core = nodesRef.current.get(CORE_ID);
      if (core) {
        core.x = w / 2;
        core.y = h / 2;
      }
    };
    resize();
    pointerRef.current = { x: window.innerWidth / 2, y: window.innerHeight / 2 };

    const onMove = (e: MouseEvent) => {
      pointerRef.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener("resize", resize);
    window.addEventListener("mousemove", onMove, { passive: true });

    const step = (dt: number) => {
      const nodes = [...nodesRef.current.values()];
      const map = nodesRef.current;
      const { w, h } = sizeRef.current;
      const cx = w / 2;
      const cy = h / 2;
      const reduced = reducedMotionRef.current;

      for (let i = 0; i < nodes.length; i++) {
        const n1 = nodes[i]!;
        for (let j = i + 1; j < nodes.length; j++) {
          const n2 = nodes[j]!;
          let dx = n1.x - n2.x;
          let dy = n1.y - n2.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 0.01) {
            dx = Math.random() - 0.5;
            dy = Math.random() - 0.5;
            d2 = 0.01;
          }
          const d = Math.sqrt(d2);
          const force = REPULSION / d2;
          const fx = (dx / d) * force;
          const fy = (dy / d) * force;
          n1.vx += fx;
          n1.vy += fy;
          n2.vx -= fx;
          n2.vy -= fy;
        }
      }

      for (const e of edgesRef.current) {
        const a = map.get(e.a);
        const b = map.get(e.b);
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const diff = ((d - e.rest) / d) * e.strength;
        const fx = dx * diff;
        const fy = dy * diff;
        if (!a.pinned) {
          a.vx += fx;
          a.vy += fy;
        }
        if (!b.pinned) {
          b.vx -= fx;
          b.vy -= fy;
        }
      }

      for (const n of nodes) {
        if (n.pinned) {
          n.x = cx;
          n.y = cy;
          n.vx = 0;
          n.vy = 0;
          continue;
        }
        n.vx += (cx - n.x) * GRAVITY;
        n.vy += (cy - n.y) * GRAVITY;
        if (!reduced) {
          n.vx += (Math.random() - 0.5) * DRIFT;
          n.vy += (Math.random() - 0.5) * DRIFT;
        }
        n.vx *= DAMP;
        n.vy *= DAMP;
        const sp = Math.hypot(n.vx, n.vy);
        if (sp > MAX_SPEED) {
          n.vx = (n.vx / sp) * MAX_SPEED;
          n.vy = (n.vy / sp) * MAX_SPEED;
        }
        n.x += n.vx * dt;
        n.y += n.vy * dt;
      }
    };

    const drawNode = (
      c: CanvasRenderingContext2D,
      n: GraphNode,
      time: number,
    ) => {
      const age = time - n.bornAt;
      let col: RGB =
        n.kind === "competency"
          ? COL_COMPETENCY
          : n.kind === "core"
            ? COL_CORE
            : COL_PRIMARY;
      let intensity = 1;
      let r = n.baseRadius;

      if (n.kind === "video") {
        if (n.status === "failed") {
          col = COL_ERROR;
          intensity = 0.7;
        } else if (n.status !== "completed") {
          intensity = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(time * 0.005 + n.x));
        }
      }
      if (n.kind === "core") {
        r = n.baseRadius * (1 + 0.08 * Math.sin(time * 0.002));
      }

      // A newly scheduled animation frame can precede a node's recorded birth
      // timestamp by a few milliseconds. Clamp at zero so the intro pulse never
      // passes a negative radius to canvas.arc().
      const grow = Math.max(0, Math.min(1, age / 600));
      r *= 0.4 + 0.6 * grow;

      const glowR = r * 5;
      // Guard the gradient axis: a non-finite node position or a non-positive
      // radius makes createRadialGradient degenerate, which Chrome/Skia renders
      // as a canvas-spanning spike (the stray blue crosshair). A node in that
      // state has nothing meaningful to draw, so skip it entirely — same
      // philosophy as pulseSegment() guarding the neural-flow linear gradient.
      if (
        !Number.isFinite(n.x) ||
        !Number.isFinite(n.y) ||
        !Number.isFinite(glowR) ||
        glowR <= 0
      ) {
        return;
      }
      const g = c.createRadialGradient(n.x, n.y, 0, n.x, n.y, glowR);
      g.addColorStop(0, rgba(col, 0.5 * intensity));
      g.addColorStop(0.4, rgba(col, 0.12 * intensity));
      g.addColorStop(1, rgba(col, 0));
      c.fillStyle = g;
      c.beginPath();
      c.arc(n.x, n.y, glowR, 0, Math.PI * 2);
      c.fill();

      c.fillStyle = rgba(col, Math.min(1, 0.85 * intensity + 0.15));
      c.beginPath();
      c.arc(n.x, n.y, r, 0, Math.PI * 2);
      c.fill();

      if (age < 1500) {
        const p = Math.max(0, age / 1500);
        c.strokeStyle = rgba(col, (1 - p) * 0.6);
        c.lineWidth = 1.2 * (1 - p) + 0.3;
        c.beginPath();
        c.arc(n.x, n.y, r + p * 42, 0, Math.PI * 2);
        c.stroke();
      }

      if (n.kind === "trade" && grow > 0.9) {
        c.font = "700 9px 'Space Mono', monospace";
        c.fillStyle = rgba(col, 0.5);
        c.textAlign = "center";
        c.fillText(n.label.toUpperCase(), n.x, n.y - r - 6);
      }
    };

    const draw = (time: number) => {
      const c = ctxRef.current;
      if (!c) return;
      const { w, h, dpr } = sizeRef.current;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.fillStyle = COL_BG;
      c.fillRect(0, 0, w, h);

      const ox = (pointerRef.current.x - w / 2) * PARALLAX;
      const oy = (pointerRef.current.y - h / 2) * PARALLAX;
      c.save();
      c.translate(ox, oy);

      const map = nodesRef.current;
      c.lineWidth = 0.7;
      for (const e of edgesRef.current) {
        const a = map.get(e.a);
        const b = map.get(e.b);
        if (!a || !b) continue;
        const col = e.kind === "competency" ? COL_COMPETENCY : COL_PRIMARY;
        const alpha = e.kind === "competency" ? 0.1 : 0.16;
        c.strokeStyle = rgba(col, alpha);
        c.beginPath();
        c.moveTo(a.x, a.y);
        c.lineTo(b.x, b.y);
        c.stroke();
      }

      for (const n of map.values()) drawNode(c, n, time);
      c.restore();
    };

    let raf = 0;
    let last = performance.now();
    const frame = (t: number) => {
      const dt = Math.min(2, (t - last) / 16.67);
      last = t;
      step(dt);
      draw(t);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", onMove);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="fixed inset-0 pointer-events-none"
      style={{ zIndex: 0 }}
    />
  );
}
