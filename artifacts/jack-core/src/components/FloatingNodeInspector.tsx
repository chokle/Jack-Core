import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { Pin, PinOff, X } from "lucide-react";
import {
  rgbCss,
  rgba,
  isKnowledgeKind,
  kindLabel as kindLabelFor,
  type MemoryNode,
} from "../lib/memory-graph";

type ScreenPos = { x: number; y: number; r: number } | null;

interface FloatingNodeInspectorProps {
  node: MemoryNode;
  degree: number;
  videoCount: number;
  pinned: boolean;
  onTogglePin: () => void;
  onClose: () => void;
  /** The graph stage element — the positioning context this card floats within. */
  stageRef: RefObject<HTMLDivElement | null>;
  /** Live screen-space position (stage-relative) of a node, or null when off-screen. */
  getScreenPos: (id: string) => ScreenPos;
  /** The node's captured-data body (sections). Rendered inside the scroll area. */
  children: ReactNode;
}

/**
 * Desktop-only floating node inspector — a purpose-built contextual card, NOT a
 * repositioned drawer. It floats over the graph stage next to the selected node
 * (think Google Maps info card / Figma comment bubble): fixed ~26rem width,
 * content-driven height capped at 70vh with internal scroll, and it NEVER pushes,
 * resizes, dims, or covers the graph edge-to-edge — the graph stays the hero.
 *
 * The card owns its own placement: a self-contained requestAnimationFrame loop
 * anchors it beside the node and follows it live as the simulation drifts /
 * the user pans or zooms. It prefers the right of the node, flips to the left
 * when it won't fit, and clamps inside the stage (below the header overlay) so
 * it can never spill off-screen. Placement is applied imperatively via a
 * transform so node drift never triggers a React re-render.
 */
export function FloatingNodeInspector({
  node,
  degree,
  videoCount,
  pinned,
  onTogglePin,
  onClose,
  stageRef,
  getScreenPos,
  children,
}: FloatingNodeInspectorProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  // Keep the latest positioner fn in a ref so the rAF loop always reads fresh
  // values without restarting every render (only node identity restarts it).
  const getPosRef = useRef(getScreenPos);
  getPosRef.current = getScreenPos;

  const knowledge = isKnowledgeKind(node.kind);
  const kLabel = kindLabelFor(node.kind);
  const subtitle =
    node.kind === "core"
      ? kLabel
      : knowledge
        ? node.meta.trade
          ? `${kLabel} · ${node.meta.trade}`
          : kLabel
        : node.meta.trade ?? kLabel;

  useEffect(() => {
    let raf = 0;
    const place = () => {
      const el = cardRef.current;
      const stage = stageRef.current;
      const pos = getPosRef.current(node.id);
      if (el && stage) {
        if (pos) {
          const sw = stage.clientWidth;
          const sh = stage.clientHeight;
          const w = el.offsetWidth;
          const h = el.offsetHeight;
          const gap = 18;
          const pad = 12;
          const topPad = 76; // clear the title + search header overlay
          // Prefer the right of the node; flip to the left if it won't fit.
          let left = pos.x + pos.r + gap;
          if (left + w > sw - pad) {
            const leftAlt = pos.x - pos.r - gap - w;
            left = leftAlt >= pad ? leftAlt : sw - w - pad;
          }
          left = Math.max(pad, Math.min(left, Math.max(pad, sw - w - pad)));
          // Vertically center on the node, then clamp within the stage.
          let top = pos.y - h / 2;
          top = Math.max(topPad, Math.min(top, Math.max(topPad, sh - h - pad)));
          el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
          el.style.visibility = "visible";
        } else {
          // Node scrolled off-screen — hide rather than pinning to an edge.
          el.style.visibility = "hidden";
        }
      }
      raf = requestAnimationFrame(place);
    };
    raf = requestAnimationFrame(place);
    return () => cancelAnimationFrame(raf);
  }, [node.id, stageRef]);

  return (
    <div
      ref={cardRef}
      style={{ visibility: "hidden" }}
      className="pointer-events-none absolute left-0 top-0 z-30 w-[26rem] max-w-[92vw]"
    >
      <div
        role="dialog"
        aria-label={`${node.label} details`}
        className="pointer-events-auto flex max-h-[70vh] flex-col overflow-hidden rounded-2xl border border-white/10 bg-card/95 shadow-2xl shadow-black/70 ring-1 ring-white/5 backdrop-blur-xl duration-200 ease-out animate-in fade-in-0 zoom-in-95"
      >
        <div className="flex items-start justify-between gap-2 border-b border-border/60 px-4 py-3">
          <div className="flex min-w-0 items-start gap-2.5">
            <span
              className="mt-1 h-3 w-3 shrink-0 rounded-full"
              style={{
                background: rgbCss(node.color),
                boxShadow: `0 0 8px ${rgba(node.color, 0.9)}`,
              }}
            />
            <div className="min-w-0">
              <div className="text-sm font-semibold leading-snug text-foreground">
                {node.label}
              </div>
              <div className="text-xs" style={{ color: rgba(node.color, 0.95) }}>
                {subtitle}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                <span>
                  <b className="font-semibold tabular-nums text-foreground">
                    {degree}
                  </b>{" "}
                  Connection{degree === 1 ? "" : "s"}
                </span>
                <span aria-hidden className="text-white/20">
                  ·
                </span>
                <span>
                  <b className="font-semibold tabular-nums text-foreground">
                    {videoCount}
                  </b>{" "}
                  Video{videoCount === 1 ? "" : "s"}
                </span>
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {node.kind !== "core" && (
              <button
                onClick={onTogglePin}
                title={pinned ? "Unpin node" : "Pin node in place"}
                aria-label={pinned ? "Unpin node" : "Pin node in place"}
                className={`-mt-1 flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
                  pinned
                    ? "bg-primary/20 text-primary"
                    : "text-muted-foreground hover:bg-white/10 hover:text-foreground"
                }`}
              >
                {pinned ? (
                  <PinOff className="h-4 w-4" />
                ) : (
                  <Pin className="h-4 w-4" />
                )}
              </button>
            )}
            <button
              onClick={onClose}
              title="Close"
              aria-label="Close"
              className="-mr-1 -mt-1 flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        {/* Keyed by node id so switching nodes resets scroll to the high-level
            view without remounting (and re-animating) the card shell. */}
        <div
          key={node.id}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3"
        >
          {children}
        </div>
      </div>
    </div>
  );
}
