import { useEffect, useRef, type CSSProperties } from "react";
import { Heart } from "lucide-react";
import { useSystemHealth } from "../hooks/use-system-health";
import type { SystemHealthSnapshotPulseColor } from "@workspace/api-client-react";

/** The heart icon is ALWAYS this red, independent of operating state. */
const HEART_RED = "#ef4444";

/**
 * SystemHealthWidget — the telemetry-driven "heartbeat" that replaces the old
 * decorative LIVE dot. It polls the live Systems Health snapshot and renders a
 * small ECG trace on a canvas that beats at the server-reported BPM, colored by
 * the current operating state (green = healthy/listening/searching, purple =
 * reasoning, orange = writing/ingesting, red = warning). The status label and
 * BPM read out alongside it, and the full vitality read-out is in the tooltip.
 *
 * Motion is real (rAF-driven) but honors `prefers-reduced-motion`: a static
 * trace is drawn instead of an animated one.
 */

const PULSE_HEX: Record<SystemHealthSnapshotPulseColor, string> = {
  green: "#34d399",
  purple: "#a78bfa",
  orange: "#fb923c",
  red: "#f87171",
};

const frac = (x: number): number => x - Math.floor(x);

/**
 * A single ECG beat as a function of beat phase p∈[0,1): a small P wave, the
 * sharp QRS complex, and a rounded T wave. Amplitude is normalized to ~[-0.25, 1].
 */
function ecg(p: number): number {
  const g = (center: number, width: number) =>
    Math.exp(-(((p - center) / width) ** 2));
  return (
    0.08 * g(0.1, 0.03) - // P
    0.1 * g(0.16, 0.01) + // Q
    1.0 * g(0.185, 0.011) - // R
    0.22 * g(0.21, 0.013) + // S
    0.16 * g(0.33, 0.032) // T
  );
}

export function SystemHealthWidget({ className }: { className?: string }) {
  const { snapshot, isOffline } = useSystemHealth();
  // When the backend is unreachable, a health widget must NOT read healthy —
  // show a red flatline instead of a misleading resting pulse.
  const color = isOffline ? PULSE_HEX.red : PULSE_HEX[snapshot.pulseColor] ?? PULSE_HEX.green;

  // Latest values read by the (persistent) animation loop without restarting it.
  const bpmTargetRef = useRef(snapshot.heartbeatBPM);
  const bpmRef = useRef(snapshot.heartbeatBPM); // eased current BPM
  const colorRef = useRef(color);
  const offlineRef = useRef(isOffline);
  bpmTargetRef.current = snapshot.heartbeatBPM;
  colorRef.current = color;
  offlineRef.current = isOffline;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef<(tSec: number) => void>(() => {});
  const phaseRef = useRef(0); // accumulated beat-clock for continuous scrolling

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced =
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    let w = 0;
    let h = 0;
    const setup = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      w = Math.max(1, Math.round(rect.width));
      h = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    setup();

    const draw = (tSec: number) => {
      ctx.clearRect(0, 0, w, h);
      const centerY = h * 0.58;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.strokeStyle = colorRef.current;

      if (offlineRef.current) {
        // Backend unreachable → flatline, no flowing pulse.
        ctx.beginPath();
        ctx.moveTo(0, centerY);
        ctx.lineTo(w, centerY);
        ctx.shadowColor = colorRef.current;
        ctx.shadowBlur = 4;
        ctx.stroke();
        ctx.shadowBlur = 0;
        return;
      }

      const amp = h * 0.42;
      // Keep beat spacing constant regardless of trace width, so a wider ECG
      // shows MORE beats (patient-monitor feel) instead of stretched ones.
      const cyclesShown = Math.max(1.4, w / 32);
      // A slow, small timing wobble (heart-rate variability): over ~8s beats
      // drift a touch early/late so the rhythm feels organic rather than a
      // looping animation. Timing only — never amplitude or brightness.
      const wobble = 0.15 * Math.sin((tSec * Math.PI * 2) / 8);
      const beatBase = phaseRef.current + wobble;
      const ys: number[] = new Array(w + 1);
      ctx.beginPath();
      for (let x = 0; x <= w; x++) {
        const phase = frac(beatBase - ((w - x) / w) * cyclesShown);
        const y = centerY - ecg(phase) * amp;
        ys[x] = y;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.shadowColor = colorRef.current;

      if (reduced) {
        // Reduced motion: one steady, fully-visible trace, no sweep.
        ctx.globalAlpha = 0.9;
        ctx.shadowBlur = 2;
        ctx.stroke();
        ctx.shadowBlur = 0;
        return;
      }

      // Keep the base trace dim so the traveling pulse clearly stands out
      // against it — a brighter band flows left→right through the trace.
      ctx.globalAlpha = 0.3;
      ctx.shadowBlur = 2;
      ctx.stroke();

      const sweepSpeed = 1 / 1.8; // ~1.8s for the pulse to cross the trace
      const head = frac(tSec * sweepSpeed) * w;
      const trail = w * 0.45;
      ctx.shadowBlur = 6;
      const startX = Math.max(1, Math.ceil(head - trail));
      const endX = Math.min(w, Math.floor(head));
      for (let x = startX; x <= endX; x++) {
        const d = (x - (head - trail)) / trail; // 0 at tail → 1 at head
        ctx.globalAlpha = 0.35 + 0.65 * d * d; // dim at the tail → bright at the head
        ctx.beginPath();
        ctx.moveTo(x - 1, ys[x - 1]);
        ctx.lineTo(x, ys[x]);
        ctx.stroke();
      }

      // A soft head marker in the state color rides the leading edge so the
      // sweep reads clearly even on the wider desktop trace (no flashy white).
      const hx = Math.min(w, Math.max(0, Math.round(head)));
      ctx.globalAlpha = 0.9;
      ctx.shadowBlur = 8;
      ctx.fillStyle = colorRef.current;
      ctx.beginPath();
      ctx.arc(hx, ys[hx] ?? centerY, 1.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
    };
    drawRef.current = draw;

    if (reduced) {
      bpmRef.current = bpmTargetRef.current;
      draw(0);
      const onResize = () => {
        setup();
        draw(0);
      };
      window.addEventListener("resize", onResize);
      // Re-measure when the canvas box itself changes (fullscreen toggles,
      // sidebar layout settling) — window 'resize' alone can miss these.
      const ro =
        typeof ResizeObserver !== "undefined" ? new ResizeObserver(onResize) : null;
      ro?.observe(canvas);
      return () => {
        window.removeEventListener("resize", onResize);
        ro?.disconnect();
      };
    }

    let raf = 0;
    let lastTs = 0;
    const loop = (ts: number) => {
      const dt = lastTs ? Math.max(0, (ts - lastTs) / 1000) : 0;
      lastTs = ts;
      // Ease the drawn BPM toward the latest target so poll-to-poll changes
      // glide back to resting gradually (over a few seconds) instead of jumping.
      bpmRef.current += (bpmTargetRef.current - bpmRef.current) * Math.min(1, dt * 0.9);
      // Advance the beat clock by the eased rate: continuous scroll whose speed
      // scales with BPM (and no phase jump when BPM eases).
      phaseRef.current += dt * (bpmRef.current / 60);
      draw(ts / 1000);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const onResize = () => setup();
    window.addEventListener("resize", onResize);
    // Re-measure when the canvas box itself changes (fullscreen toggles,
    // sidebar layout settling) — the loop redraws each frame afterward.
    const ro =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(onResize) : null;
    ro?.observe(canvas);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      ro?.disconnect();
    };
  }, []);

  // When reduced motion is on, the loop above draws only once — refresh the
  // static trace when the reported color/BPM (or offline state) changes.
  useEffect(() => {
    const reduced =
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (reduced) {
      bpmRef.current = snapshot.heartbeatBPM;
      drawRef.current(0);
    }
  }, [snapshot.pulseColor, snapshot.heartbeatBPM, isOffline]);

  // Beat duration for the heart icon, derived from BPM (clamped to sane bounds).
  const bpmForBeat = Math.max(30, Math.min(200, snapshot.heartbeatBPM));
  const beatDuration = `${(60 / bpmForBeat).toFixed(2)}s`;

  const statusLabel = isOffline ? "Offline" : snapshot.status;
  const ariaLabel = isOffline
    ? "Systems health: offline, backend unreachable"
    : `Systems health: ${snapshot.status}, ${snapshot.heartbeatBPM} beats per minute, vitality ${snapshot.vitalityScore} of 100`;
  const title = isOffline
    ? "Systems Health · Offline (backend unreachable)"
    : `Vitality ${snapshot.vitalityScore}/100 · ${snapshot.heartbeatBPM} BPM · ${snapshot.status}`;

  return (
    <div
      className={`flex items-center gap-1.5 ${className ?? ""}`}
      role="img"
      aria-label={ariaLabel}
      title={title}
    >
      <Heart
        className={`h-3.5 w-3.5 shrink-0 ${isOffline ? "" : "jack-heart-beat"}`}
        style={
          {
            color: HEART_RED,
            fill: HEART_RED,
            "--jack-beat-duration": beatDuration,
          } as CSSProperties
        }
        aria-hidden="true"
      />
      <canvas ref={canvasRef} className="h-4 w-16 shrink-0 md:w-24" aria-hidden="true" />
      <div className="flex flex-col justify-center leading-tight">
        <span
          className="hidden items-center gap-1 font-mono text-[9px] font-semibold uppercase tracking-[0.12em] sm:flex"
          style={{ color }}
        >
          <span
            className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: color }}
            aria-hidden="true"
          />
          {statusLabel}
        </span>
        <span
          className="font-mono text-[10px] font-semibold tabular-nums"
          style={{ color }}
        >
          {isOffline ? "--" : snapshot.heartbeatBPM}
          <span className="ml-0.5 text-muted-foreground">BPM</span>
        </span>
      </div>
    </div>
  );
}
