import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Button } from "@/components/ui/button";

interface RecordingIndicatorProps {
  /** Read on a timer rather than passed as a prop, so the parent never needs
   *  to re-render every second just to keep the clock ticking. */
  getElapsedMs: () => number;
  isPaused: boolean;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  micIncluded: boolean;
}

const PAD = 12;

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Small, minimally-intrusive, draggable pill shown while a beta-test
 * recording is active. Placement is driven imperatively via a ref-owned
 * transform (same convention as FloatingPanel.tsx) so it never fights a
 * parent re-render mid-drag; it isn't a windowed panel, so it keeps its own
 * lightweight drag mechanics rather than reusing FloatingPanel wholesale.
 */
export function RecordingIndicator({
  getElapsedMs,
  isPaused,
  onPause,
  onResume,
  onStop,
  micIncluded,
}: RecordingIndicatorProps) {
  const elRef = useRef<HTMLDivElement>(null);
  const posRef = useRef<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(
    null,
  );
  const [ready, setReady] = useState(false);
  const [elapsedLabel, setElapsedLabel] = useState("00:00");

  useLayoutEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const x = Math.max(PAD, window.innerWidth - el.offsetWidth - PAD);
    const y = PAD;
    posRef.current = { x, y };
    el.style.transform = `translate(${x}px, ${y}px)`;
    setReady(true);
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => {
      setElapsedLabel(formatElapsed(getElapsedMs()));
    }, 500);
    return () => window.clearInterval(id);
  }, [getElapsedMs]);

  const clamp = (x: number, y: number) => {
    const el = elRef.current;
    const maxX = Math.max(0, window.innerWidth - (el?.offsetWidth ?? 0));
    const maxY = Math.max(0, window.innerHeight - (el?.offsetHeight ?? 0));
    return { x: Math.min(Math.max(x, 0), maxX), y: Math.min(Math.max(y, 0), maxY) };
  };

  const applyTransform = () => {
    const el = elRef.current;
    const p = posRef.current;
    if (el && p) el.style.transform = `translate(${p.x}px, ${p.y}px)`;
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    const p = posRef.current;
    if (!p) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    dragRef.current = { startX: e.clientX, startY: e.clientY, originX: p.x, originY: p.y };
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const next = clamp(d.originX + (e.clientX - d.startX), d.originY + (e.clientY - d.startY));
    posRef.current = next;
    applyTransform();
  };

  const endDrag = (e: ReactPointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  return (
    <div
      ref={elRef}
      role="status"
      aria-live="polite"
      data-testid="user-testing-recording-indicator"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      style={{ touchAction: "none", visibility: ready ? "visible" : "hidden" }}
      className="fixed left-0 top-0 z-[100] flex cursor-grab select-none items-center gap-2.5 rounded-full border border-white/10 bg-card/95 py-2 pl-3.5 pr-2 text-sm shadow-2xl shadow-black/70 ring-1 ring-white/5 backdrop-blur-xl active:cursor-grabbing"
    >
      <span className="flex items-center gap-1.5 whitespace-nowrap font-semibold text-foreground">
        <span
          className={`h-2 w-2 shrink-0 rounded-full bg-red-500 ${isPaused ? "" : "animate-pulse"}`}
          aria-hidden
        />
        {isPaused ? "Paused" : "🔴 Recording User Test"}
      </span>
      <span className="font-mono text-xs tabular-nums text-muted-foreground">{elapsedLabel}</span>
      {!micIncluded && (
        <span
          className="whitespace-nowrap rounded-full bg-muted/60 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground"
          title="Microphone not included in this recording"
        >
          screen only
        </span>
      )}
      <Button type="button" size="sm" variant="ghost" onClick={isPaused ? onResume : onPause}>
        {isPaused ? "Resume" : "Pause"}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="destructive"
        onClick={onStop}
        data-testid="user-testing-stop"
      >
        Stop Test
      </Button>
    </div>
  );
}
