import { useEffect, useRef } from "react";
import { useSystemHealth } from "../hooks/use-system-health";
import type { SystemHealthSnapshotPulseColor } from "@workspace/api-client-react";

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
      ctx.beginPath();
      if (offlineRef.current) {
        // Backend unreachable → flatline.
        ctx.moveTo(0, centerY);
        ctx.lineTo(w, centerY);
      } else {
        const amp = h * 0.42;
        const cyclesShown = 1.8;
        const beatsPerSec = bpmRef.current / 60;
        for (let x = 0; x <= w; x++) {
          const phase = frac(tSec * beatsPerSec - ((w - x) / w) * cyclesShown);
          const y = centerY - ecg(phase) * amp;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
      }
      ctx.strokeStyle = colorRef.current;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.shadowColor = colorRef.current;
      ctx.shadowBlur = 4;
      ctx.stroke();
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
      return () => window.removeEventListener("resize", onResize);
    }

    let raf = 0;
    let lastTs = 0;
    const loop = (ts: number) => {
      const dt = lastTs ? Math.max(0, (ts - lastTs) / 1000) : 0;
      lastTs = ts;
      // Ease the drawn BPM toward the latest target so poll-to-poll changes
      // glide instead of jumping.
      bpmRef.current += (bpmTargetRef.current - bpmRef.current) * Math.min(1, dt * 2.5);
      draw(ts / 1000);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const onResize = () => setup();
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
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
      <canvas ref={canvasRef} className="h-4 w-11 shrink-0" aria-hidden="true" />
      <span
        className="hidden font-mono text-[10px] font-semibold uppercase tracking-[0.12em] sm:inline"
        style={{ color }}
      >
        {statusLabel}
      </span>
      <span className="font-mono text-[10px] font-semibold tabular-nums" style={{ color }}>
        {isOffline ? "--" : snapshot.heartbeatBPM}
        <span className="ml-0.5 text-muted-foreground">BPM</span>
      </span>
    </div>
  );
}
