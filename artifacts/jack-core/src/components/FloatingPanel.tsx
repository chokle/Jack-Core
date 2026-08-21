import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Maximize2, Minus, X } from "lucide-react";

/** Where the panel first appears when there is no remembered session position. */
type Placement = "bottom" | "top-right" | { x: number; y: number };

type XY = { x: number; y: number };
type Bounds = { sw: number; sh: number; pw: number; ph: number };

interface FloatingPanelProps {
  /** Left side of the header — title, subtitle, stats, etc. */
  headerContent: ReactNode;
  /** Optional extra header buttons rendered left of the close (X) button. */
  headerActions?: ReactNode;
  /** Panel body. Scrolls independently of the graph. */
  children: ReactNode;
  onClose: () => void;
  /** Expanded/minimized presentation; closed panels are unmounted by the owner. */
  state?: "expanded" | "minimized";
  onMinimize?: () => void;
  onRestore?: () => void;
  /** Compact identity rendered inside the minimized pill. */
  minimizedContent?: ReactNode;
  /** The positioning context the panel floats within (position: relative). */
  stageRef: RefObject<HTMLElement | null>;
  /**
   * Stable key for session position memory (sessionStorage). Panels that share a
   * key share a remembered position; omit to disable persistence.
   */
  positionKey?: string;
  /** First-open placement when nothing is remembered for this session. */
  defaultPlacement?: Placement;
  /** Desired width in px (clamped to the viewport via max-width). */
  width?: number;
  /** CSS max-height for the whole panel (body scrolls within it). */
  maxHeight?: string;
  /**
   * Changing this remounts the scroll body, resetting its scroll position — pass
   * the current content id so switching content starts at the top. It also
   * re-clamps the panel in case the new content is taller.
   */
  bodyKey?: string;
  ariaLabel?: string;
  /**
   * Desktop renders a draggable floating window; mobile renders a docked
   * bottom sheet (full-width, rounded top corners, swipe-down-to-dismiss on
   * the header, safe-area-aware bottom padding). Defaults to desktop.
   */
  isDesktop?: boolean;
}

const PAD = 12;
// Clear the graph's title + search header overlay so the panel never opens under it.
const TOP_PAD = 76;

function storageKey(key: string): string {
  return `floating-panel:${key}`;
}

function readStored(key?: string): XY | null {
  if (!key || typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(storageKey(key));
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<XY>;
    if (typeof p?.x === "number" && typeof p?.y === "number") {
      return { x: p.x, y: p.y };
    }
  } catch {
    /* ignore malformed / unavailable storage */
  }
  return null;
}

function writeStored(key: string | undefined, pos: XY): void {
  if (!key || typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(storageKey(key), JSON.stringify(pos));
  } catch {
    /* ignore quota / unavailable storage */
  }
}

/** Keep the panel fully inside the stage (and below the header overlay). */
function clampPos(p: XY, b: Bounds): XY {
  const maxX = Math.max(PAD, b.sw - b.pw - PAD);
  const maxY = Math.max(TOP_PAD, b.sh - b.ph - PAD);
  return {
    x: Math.min(Math.max(p.x, PAD), maxX),
    y: Math.min(Math.max(p.y, TOP_PAD), maxY),
  };
}

function placementToXY(placement: Placement | undefined, b: Bounds): XY {
  if (placement && typeof placement === "object") return placement;
  if (placement === "bottom") {
    return { x: Math.round((b.sw - b.pw) / 2), y: b.sh - b.ph - PAD };
  }
  // default: top-right
  return { x: b.sw - b.pw - PAD, y: TOP_PAD };
}

/**
 * A reusable, draggable floating window (NOT a blocking modal). It floats over a
 * stage, is dragged by its header (mouse or single-finger touch), clamps itself
 * fully on-screen, and remembers its position for the session. The body scrolls
 * independently so it never fights graph panning. Built to host node details,
 * video metadata, AI explanations, search results, or knowledge cards.
 *
 * Placement is driven IMPERATIVELY from a ref (never React inline style): a
 * parent re-render mid-drag (polling, toasts, zoom) must never clobber the live
 * drag position, so `transform` is written directly and re-applied on our own
 * layout effects only.
 */
export function FloatingPanel({
  headerContent,
  headerActions,
  children,
  onClose,
  state = "expanded",
  onMinimize,
  onRestore,
  minimizedContent,
  stageRef,
  positionKey,
  defaultPlacement,
  width = 416,
  maxHeight = "70vh",
  bodyKey,
  ariaLabel,
  isDesktop = true,
}: FloatingPanelProps) {
  // All hooks below run unconditionally (desktop and mobile alike) — the
  // mobile-sheet render swap happens at the very end, at the JSX return, so
  // this never trips the Rules of Hooks even though `isDesktop` can flip at
  // runtime (viewport resize / rotation).
  const panelRef = useRef<HTMLDivElement>(null);
  // The single source of truth for placement (avoids state-driven transform).
  const posRef = useRef<XY | null>(null);
  const [ready, setReady] = useState(false);
  // Live drag origin + captured stage/panel bounds; null when not dragging.
  const dragRef = useRef<
    | ({
        startX: number;
        startY: number;
        originX: number;
        originY: number;
      } & Bounds)
    | null
  >(null);

  const measure = (): Bounds | null => {
    const stage = stageRef.current;
    const el = panelRef.current;
    if (!stage || !el) return null;
    return {
      sw: stage.clientWidth,
      sh: stage.clientHeight,
      pw: el.offsetWidth,
      ph: el.offsetHeight,
    };
  };

  const applyTransform = () => {
    const el = panelRef.current;
    const p = posRef.current;
    if (el && p) el.style.transform = `translate(${p.x}px, ${p.y}px)`;
  };

  // Initial placement — measured after layout so size is real. Runs on mount and
  // if the persistence identity changes, but NOT on content swaps.
  useLayoutEffect(() => {
    if (!isDesktop || state !== "expanded") {
      setReady(false);
      return;
    }
    let frame = 0;
    const place = () => {
      const b = measure();
      if (!b) {
        frame = window.requestAnimationFrame(place);
        return;
      }
      const start =
        readStored(positionKey) ?? placementToXY(defaultPlacement, b);
      posRef.current = clampPos(start, b);
      applyTransform();
      setReady(true);
    };
    place();
    return () => window.cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDesktop, positionKey, state]);

  // Re-clamp when the body content changes (e.g. switching to a taller node) so
  // the panel can never hang past the stage edge after a content swap.
  useLayoutEffect(() => {
    const b = measure();
    if (!b || !posRef.current) return;
    posRef.current = clampPos(posRef.current, b);
    applyTransform();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bodyKey]);

  // Re-clamp on stage resize so a remembered position never lands off-screen.
  useEffect(() => {
    const onResize = () => {
      const b = measure();
      if (!b || !posRef.current) return;
      posRef.current = clampPos(posRef.current, b);
      applyTransform();
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageRef]);

  const dragTo = (e: ReactPointerEvent): XY | null => {
    const d = dragRef.current;
    if (!d) return null;
    return clampPos(
      {
        x: d.originX + (e.clientX - d.startX),
        y: d.originY + (e.clientY - d.startY),
      },
      d,
    );
  };

  const onHeaderPointerDown = (e: ReactPointerEvent) => {
    // Let header buttons (pin / close) behave as buttons, not drag handles.
    if ((e.target as HTMLElement).closest("button")) return;
    const p = posRef.current;
    const b = measure();
    if (!p || !b) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      originX: p.x,
      originY: p.y,
      ...b,
    };
  };

  const onHeaderPointerMove = (e: ReactPointerEvent) => {
    const next = dragTo(e);
    if (!next) return;
    posRef.current = next;
    applyTransform();
  };

  const endDrag = (e: ReactPointerEvent) => {
    if (!dragRef.current) return;
    const next = dragTo(e);
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (next) {
      posRef.current = next;
      applyTransform();
      writeStored(positionKey, next);
    }
  };

  // `transform` is deliberately absent here — it is owned by applyTransform().
  const style: CSSProperties = {
    width,
    maxHeight,
    visibility: ready ? "visible" : "hidden",
  };

  if (state === "minimized") {
    return (
      <MinimizedPill
        stageRef={stageRef}
        positionKey={positionKey}
        ariaLabel={ariaLabel}
        isDesktop={isDesktop}
        onRestore={onRestore}
      >
        {minimizedContent ?? headerContent}
      </MinimizedPill>
    );
  }

  if (!isDesktop) {
    return (
      <MobileSheet
        headerContent={headerContent}
        headerActions={headerActions}
        onClose={onClose}
        onMinimize={onMinimize}
        maxHeight={maxHeight}
        bodyKey={bodyKey}
        ariaLabel={ariaLabel}
      >
        {children}
      </MobileSheet>
    );
  }

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={ariaLabel}
      style={style}
      className="pointer-events-auto absolute left-0 top-0 z-30 flex max-w-[95vw] flex-col overflow-hidden rounded-2xl border border-white/10 bg-card/95 shadow-2xl shadow-black/70 ring-1 ring-white/5 backdrop-blur-xl duration-200 ease-out animate-in fade-in-0 zoom-in-95"
    >
      <div
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        style={{ touchAction: "none" }}
        className="flex cursor-grab select-none items-start justify-between gap-2 border-b border-border/60 px-4 py-3 active:cursor-grabbing"
      >
        <div className="min-w-0 flex-1">{headerContent}</div>
        <div className="flex shrink-0 items-center gap-1">
          {headerActions}
          {onMinimize && (
            <button
              onClick={onMinimize}
              title="Minimize"
              aria-label="Minimize"
              className="-mt-1 flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground"
            >
              <Minus className="h-4 w-4" />
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
      <div
        key={bodyKey}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3"
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Mobile counterpart to the desktop draggable window: a docked bottom sheet.
 * Full-width, rounded top corners only, safe-area-aware bottom padding, and a
 * swipe-down gesture on the header (or its drag handle) to dismiss — no
 * free-drag positioning since there's no room to relocate it on a phone.
 */
function MobileSheet({
  headerContent,
  headerActions,
  children,
  onClose,
  onMinimize,
  maxHeight,
  bodyKey,
  ariaLabel,
}: {
  headerContent: ReactNode;
  headerActions?: ReactNode;
  children: ReactNode;
  onClose: () => void;
  onMinimize?: () => void;
  maxHeight?: string;
  bodyKey?: string;
  ariaLabel?: string;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startY: number; dy: number } | null>(null);

  const setDy = (dy: number) => {
    const el = sheetRef.current;
    if (!el) return;
    el.style.transform = dy > 0 ? `translateY(${dy}px)` : "translateY(0px)";
  };

  const onHeaderPointerDown = (e: ReactPointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    dragRef.current = { startY: e.clientY, dy: 0 };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  const onHeaderPointerMove = (e: ReactPointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dy = Math.max(0, e.clientY - d.startY);
    d.dy = dy;
    setDy(dy);
  };

  const endDrag = (e: ReactPointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (!d) return;
    // A decisive downward swipe dismisses; anything short springs back open.
    if (d.dy > 90) {
      onClose();
    } else {
      setDy(0);
    }
  };

  return (
    <div
      ref={sheetRef}
      role="dialog"
      aria-label={ariaLabel}
      style={{ maxHeight: maxHeight ?? "80dvh" }}
      className="pointer-events-auto absolute inset-x-0 bottom-0 z-30 flex w-full flex-col overflow-hidden rounded-t-2xl border-t border-white/10 bg-card/95 shadow-2xl shadow-black/70 ring-1 ring-white/5 backdrop-blur-xl duration-200 ease-out animate-in slide-in-from-bottom-4 fade-in-0"
    >
      <div
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        style={{ touchAction: "none" }}
        className="flex select-none flex-col gap-2 border-b border-border/60 px-4 pb-3 pt-2 active:cursor-grabbing"
      >
        <div
          className="mx-auto h-1.5 w-10 shrink-0 rounded-full bg-white/20"
          aria-hidden
        />
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">{headerContent}</div>
          <div className="flex shrink-0 items-center gap-1">
            {headerActions}
            {onMinimize && (
              <button
                onClick={onMinimize}
                title="Minimize"
                aria-label="Minimize"
                className="-mt-1 flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors active:bg-white/10 active:text-foreground"
              >
                <Minus className="h-5 w-5" />
              </button>
            )}
            <button
              onClick={onClose}
              title="Close"
              aria-label="Close"
              className="-mr-1 -mt-1 flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors active:bg-white/10 active:text-foreground"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>
      </div>
      <div
        key={bodyKey}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Compact, docked identity for a minimized inspector. On phones it stays on the
 * bottom edge and can be dragged horizontally out of the way; a tap restores
 * the full sheet. Desktop uses the same unobtrusive bottom-edge affordance.
 */
function MinimizedPill({
  stageRef,
  positionKey,
  ariaLabel,
  isDesktop,
  onRestore,
  children,
}: {
  stageRef: RefObject<HTMLElement | null>;
  positionKey?: string;
  ariaLabel?: string;
  isDesktop: boolean;
  onRestore?: () => void;
  children: ReactNode;
}) {
  const pillRef = useRef<HTMLButtonElement>(null);
  const xRef = useRef<number | null>(null);
  const dragRef = useRef<{
    startX: number;
    originX: number;
    moved: number;
    maxX: number;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const [ready, setReady] = useState(false);
  const minimizedKey = positionKey ? `${positionKey}:minimized` : undefined;

  const clampX = (x: number, maxX: number) =>
    Math.min(Math.max(x, PAD), Math.max(PAD, maxX));

  const measure = () => {
    const stage = stageRef.current;
    const pill = pillRef.current;
    if (!stage || !pill) return null;
    return { maxX: stage.clientWidth - pill.offsetWidth - PAD };
  };

  const applyX = () => {
    if (pillRef.current && xRef.current != null) {
      pillRef.current.style.transform = `translateX(${xRef.current}px)`;
    }
  };

  useEffect(() => {
    let frame = 0;
    const place = () => {
      const bounds = measure();
      if (!bounds) {
        frame = window.requestAnimationFrame(place);
        return;
      }
      const stored = readStored(minimizedKey);
      // Start centered along the bottom edge so the pill does not cover the
      // graph's bottom-right zoom and lock controls.
      const centeredX = (PAD + bounds.maxX) / 2;
      xRef.current = clampX(stored?.x ?? centeredX, bounds.maxX);
      applyX();
      setReady(true);
    };
    place();
    return () => window.cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minimizedKey]);

  useEffect(() => {
    const onResize = () => {
      const bounds = measure();
      if (!bounds || xRef.current == null) return;
      xRef.current = clampX(xRef.current, bounds.maxX);
      applyX();
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageRef]);

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    suppressClickRef.current = false;
    const bounds = measure();
    if (!bounds || xRef.current == null) return;
    dragRef.current = {
      startX: e.clientX,
      originX: xRef.current,
      moved: 0,
      maxX: bounds.maxX,
    };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    drag.moved = Math.max(drag.moved, Math.abs(dx));
    xRef.current = clampX(drag.originX + dx, drag.maxX);
    applyX();
  };

  const endDrag = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (!drag) return;
    if (xRef.current != null) {
      writeStored(minimizedKey, { x: xRef.current, y: 0 });
    }
    suppressClickRef.current = drag.moved >= 6;
  };

  return (
    <button
      ref={pillRef}
      type="button"
      data-panel-state="minimized"
      aria-label={`Restore ${ariaLabel ?? "details"}`}
      title="Restore details"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onClick={() => {
        if (suppressClickRef.current) {
          suppressClickRef.current = false;
          return;
        }
        onRestore?.();
      }}
      style={{
        visibility: ready ? "visible" : "hidden",
        touchAction: "none",
        bottom: isDesktop ? PAD : "max(0.75rem, env(safe-area-inset-bottom))",
      }}
      className="pointer-events-auto absolute left-0 z-30 flex h-11 max-w-[calc(100%_-_1.5rem)] cursor-grab items-center gap-2 rounded-full border border-white/10 bg-card/95 px-3 text-sm font-medium shadow-xl shadow-black/60 ring-1 ring-white/5 backdrop-blur-xl active:cursor-grabbing md:max-w-72"
    >
      <span className="min-w-0 flex-1 truncate text-left">{children}</span>
      <Maximize2
        className="h-4 w-4 shrink-0 text-muted-foreground"
        aria-hidden
      />
    </button>
  );
}
