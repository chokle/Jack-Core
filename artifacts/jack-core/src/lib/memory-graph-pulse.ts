/**
 * memory-graph-pulse — the "neural flow" of Jack's Living Memory.
 *
 * A pure, deterministic state machine (no canvas, no DOM, no clock of its own):
 * the render loop feeds it `now` (ms) each frame via `update()` and reads back
 * the active pulses via `getPulses()` to draw them against the LIVE node
 * positions. The only randomness is timing + which cluster/branches to fire, and
 * the RNG is injectable, so the whole controller is unit-testable in isolation —
 * the same pure-module + colocated-test convention as `graph-perf`.
 *
 * Behavior (one ambient event every few seconds, never overlapping):
 *   1. Pick a random cluster head (topic hub) bridged to the core.
 *   2. Send ONE primary pulse Core → that hub.
 *   3. When it arrives, fan out short secondary pulses along every branch of that
 *      cluster (capped + lightly staggered for subtlety), then fall quiet until
 *      the next interval elapses.
 *
 * Topology is pulled from the real graph (never hardcoded to specific trades):
 * the canvas derives hubs/members from live adjacency and hands them in via
 * `setTopology`, so new clusters light up automatically.
 */

import type { RGB } from "./memory-graph";

export type PulseKind = "primary" | "secondary";

/** A pulse the renderer should draw, as an edge + progress (0..1) along it. */
export interface ActivePulse {
  fromId: string;
  toId: string;
  /** 0..1 progress from `fromId` toward `toId`. */
  t: number;
  kind: PulseKind;
}

interface InternalPulse extends ActivePulse {
  /** Progress gained per second. */
  speed: number;
  /** Seconds still to wait before this pulse starts moving (fan-out stagger). */
  delay: number;
}

/** Live graph shape the controller fires through — core → hubs → members. */
export interface PulseTopology {
  coreId: string;
  /** Cluster-head ids bridged to the core (the trunks a primary can travel). */
  hubIds: string[];
  /** Member (branch endpoint) ids per hub. */
  membersByHub: Record<string, string[]>;
}

export interface PulseControllerOptions {
  /** Min seconds between neural events. */
  minIntervalSec?: number;
  /** Max seconds between neural events. */
  maxIntervalSec?: number;
  /** Delay (s) before the very first event, so the graph shows life promptly. */
  firstDelaySec?: number;
  /** Seconds for the primary pulse to travel core → hub. */
  primaryTravelSec?: number;
  /** Seconds for each secondary pulse to travel hub → member. */
  secondaryTravelSec?: number;
  /** Max simultaneous fan-out pulses (subtlety + a perf ceiling on huge hubs). */
  maxFanout?: number;
  /** Max random stagger (s) spread across a fan-out, for an organic burst. */
  fanoutStaggerSec?: number;
  /** Clamp on dt per update, so a backgrounded tab can't jump pulses on resume. */
  maxStepSec?: number;
  /** Injectable RNG in [0, 1) for deterministic tests. */
  random?: () => number;
}

const DEFAULTS: Required<Omit<PulseControllerOptions, "random">> & {
  random: () => number;
} = {
  minIntervalSec: 6,
  maxIntervalSec: 8,
  firstDelaySec: 3,
  primaryTravelSec: 1.1,
  secondaryTravelSec: 0.8,
  maxFanout: 40,
  fanoutStaggerSec: 0.25,
  maxStepSec: 0.1,
  random: Math.random,
};

/** Default green — "healthy / idle", also the fallback when no state is known. */
const DEFAULT_COLOR: RGB = [110, 231, 183];

export class MemoryGraphPulseController {
  private readonly opts: Required<PulseControllerOptions>;
  private topology: PulseTopology = { coreId: "", hubIds: [], membersByHub: {} };
  private enabled = true;
  private color: RGB = DEFAULT_COLOR;

  private primary: InternalPulse | null = null;
  private secondaries: InternalPulse[] = [];

  private started = false;
  private lastMs: number | null = null;
  private nextEventMs = 0;

  constructor(options: PulseControllerOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
  }

  /** Replace the live topology (called whenever the graph model rebuilds). */
  setTopology(topology: PulseTopology): void {
    this.topology = topology;
  }

  /**
   * Enable/disable the flow. Disabling (reduced motion, locked view) clears any
   * in-flight pulses and re-arms the first-event delay on the next enable, so
   * toggling never leaves a stranded pulse or an instant burst.
   */
  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    if (!on) {
      this.primary = null;
      this.secondaries = [];
      this.started = false;
      this.lastMs = null;
    }
  }

  setColor(rgb: RGB): void {
    this.color = rgb;
  }

  getColor(): RGB {
    return this.color;
  }

  /** True while a primary or any secondary pulse is live (cheap draw guard). */
  hasActivity(): boolean {
    return this.primary !== null || this.secondaries.length > 0;
  }

  /** Pulses currently moving (past their stagger delay), for the renderer. */
  getPulses(): ActivePulse[] {
    const out: ActivePulse[] = [];
    if (this.primary && this.primary.delay <= 0) {
      const { fromId, toId, t, kind } = this.primary;
      out.push({ fromId, toId, t, kind });
    }
    for (const s of this.secondaries) {
      if (s.delay > 0) continue;
      out.push({ fromId: s.fromId, toId: s.toId, t: s.t, kind: s.kind });
    }
    return out;
  }

  /** Advance the flow to wall-clock `nowMs`. Safe to call every frame. */
  update(nowMs: number): void {
    if (!this.enabled) return;
    if (!this.started) {
      this.started = true;
      this.lastMs = nowMs;
      this.nextEventMs = nowMs + this.opts.firstDelaySec * 1000;
      return;
    }

    const dt = Math.min(
      this.opts.maxStepSec,
      Math.max(0, (nowMs - (this.lastMs ?? nowMs)) / 1000),
    );
    this.lastMs = nowMs;

    // Advance existing secondaries BEFORE the primary can arrive: a fan-out
    // spawned this frame must wait for the next one rather than jumping forward
    // by a whole (possibly large, post-resume) dt on the frame it is born.
    this.advanceSecondaries(dt);
    this.advancePrimary(dt);

    // A new event only begins once the previous burst has fully settled AND the
    // interval has elapsed — that gives quiet gaps rather than constant motion.
    if (!this.hasActivity() && nowMs >= this.nextEventMs) {
      this.startPrimary();
      this.scheduleNext(nowMs);
    }
  }

  private advancePrimary(dt: number): void {
    const p = this.primary;
    if (!p) return;
    if (p.delay > 0) {
      p.delay -= dt;
      return;
    }
    p.t += p.speed * dt;
    if (p.t >= 1) {
      const hub = p.toId;
      this.primary = null;
      this.spawnFanout(hub);
    }
  }

  private advanceSecondaries(dt: number): void {
    if (this.secondaries.length === 0) return;
    for (const s of this.secondaries) {
      if (s.delay > 0) s.delay -= dt;
      else s.t += s.speed * dt;
    }
    this.secondaries = this.secondaries.filter((s) => s.t < 1);
  }

  private startPrimary(): void {
    const hubs = this.topology.hubIds;
    if (hubs.length === 0) return; // nothing to fire yet — retry next interval
    const idx = Math.floor(this.opts.random() * hubs.length) % hubs.length;
    this.primary = {
      fromId: this.topology.coreId,
      toId: hubs[idx],
      t: 0,
      kind: "primary",
      speed: 1 / this.opts.primaryTravelSec,
      delay: 0,
    };
  }

  private spawnFanout(hubId: string): void {
    const all = this.topology.membersByHub[hubId] ?? [];
    const { maxFanout, fanoutStaggerSec, secondaryTravelSec, random } = this.opts;
    const members =
      all.length > maxFanout ? sampleSubset(all, maxFanout, random) : all;
    this.secondaries = members.map((toId) => ({
      fromId: hubId,
      toId,
      t: 0,
      kind: "secondary" as const,
      speed: 1 / secondaryTravelSec,
      delay: random() * fanoutStaggerSec,
    }));
  }

  private scheduleNext(nowMs: number): void {
    const { minIntervalSec, maxIntervalSec, random } = this.opts;
    const span = Math.max(0, maxIntervalSec - minIntervalSec);
    this.nextEventMs = nowMs + (minIntervalSec + random() * span) * 1000;
  }
}

/** A resolved comet segment in world space: a short trail (tail → head). */
export interface PulseSegment {
  /** Trailing (faded) end of the comet. */
  tx: number;
  ty: number;
  /** Leading (bright) head of the comet — where the pulse currently is. */
  hx: number;
  hy: number;
}

/**
 * Resolve a pulse's short comet segment along an edge from LIVE endpoint
 * positions and progress, or `null` when the geometry is degenerate.
 *
 * The renderer feeds the returned coords straight into `createLinearGradient`;
 * a non-finite or zero-length gradient axis renders as a canvas-spanning spike
 * (the stray "blue line"), so this guards both cases:
 *   - any non-finite endpoint (a node briefly resolving to NaN/Infinity) → null
 *   - a head and tail that coincide (t at the very start, or a zero-length edge
 *     where the two nodes overlap) → null
 * The trail is always at most `trailFraction` of the edge, so a valid pulse is a
 * short comet, never the whole edge.
 */
export function pulseSegment(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  t: number,
  trailFraction: number,
): PulseSegment | null {
  if (
    !Number.isFinite(ax) ||
    !Number.isFinite(ay) ||
    !Number.isFinite(bx) ||
    !Number.isFinite(by)
  ) {
    return null;
  }
  const head = Math.max(0, Math.min(1, t));
  const tail = Math.max(0, head - Math.max(0, trailFraction));
  const hx = ax + (bx - ax) * head;
  const hy = ay + (by - ay) * head;
  const tx = ax + (bx - ax) * tail;
  const ty = ay + (by - ay) * tail;
  if (hx === tx && hy === ty) return null;
  return { tx, ty, hx, hy };
}

/** Random distinct `count` items from `items` (partial Fisher–Yates). */
function sampleSubset<T>(items: T[], count: number, random: () => number): T[] {
  const copy = items.slice();
  const n = Math.min(count, copy.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(random() * (copy.length - i));
    const k = j < copy.length ? j : copy.length - 1;
    [copy[i], copy[k]] = [copy[k], copy[i]];
  }
  return copy.slice(0, n);
}
