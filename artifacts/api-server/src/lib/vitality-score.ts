/**
 * vitality-score — pure, deterministic mapping from live telemetry signals to
 * the coarse Systems Health snapshot the heartbeat widget renders.
 *
 * No randomness, no `Date.now()`, no I/O: the caller (the Vitality Engine)
 * passes already-derived signals (in-flight counts + "ms since" deltas + sampled
 * cpu/ram) and gets back a fully determined snapshot, so the whole mapping is
 * unit-testable in isolation. This mirrors the pure-module + colocated-test
 * convention used for the graph-perf geometry on the frontend: drawn/served
 * behavior can't drift from tested behavior because both import this module.
 */

export type VitalityState =
  | "idle"
  | "listening"
  | "searching"
  | "reasoning"
  | "writing"
  | "error";

export type PulseColor = "green" | "purple" | "orange" | "red";

export type VitalityStatus =
  | "Healthy"
  | "Listening"
  | "Searching Memory"
  | "Reasoning"
  | "Writing Memory"
  | "Warning";

/**
 * Derived telemetry inputs. Counts are current in-flight gauges; `msSince*` are
 * already-computed deltas (Infinity when the event has never happened) so this
 * module never reads the clock. `cpuPercent`/`memPercent` are 0..1 fractions.
 */
export interface VitalitySignals {
  /** In-flight LLM inferences (chat completions + embedding API calls). */
  llmInFlight: number;
  /** In-flight knowledge-graph writes (video/mentor distillation + verify). */
  memoryWriteInFlight: number;
  /** In-flight video-ingestion pipeline runs (transcribe → analyze → index). */
  jobsInFlight: number;
  /** Active meaningful (non-GET) API requests. */
  activeRequests: number;
  /** ms since the last pgvector RAG search. */
  msSinceMemorySearch: number;
  /** ms since the last knowledge-graph write completed. */
  msSinceMemoryWrite: number;
  /** ms since the last error signal (failed knowledge write / inference error). */
  msSinceError: number;
  /** Sampled process CPU utilisation, 0..1. */
  cpuPercent: number;
  /** Sampled process RSS / total memory, 0..1. */
  memPercent: number;
}

export interface VitalitySnapshot {
  /** 0..100 health index (100 = healthy). Activity is conveyed by state/BPM. */
  vitalityScore: number;
  state: VitalityState;
  status: VitalityStatus;
  /** Beats per minute, an integer within the current state's band. */
  heartbeatBPM: number;
  pulseColor: PulseColor;
}

// --- tunable windows (ms) --------------------------------------------------

/** An error within this window forces the Warning (red) state. */
export const ERROR_ACTIVE_MS = 15_000;
/** A RAG search this recent still reads as "Searching Memory". */
export const SEARCH_ACTIVE_MS = 4_000;
/** A completed graph write this recent still reads as "Writing Memory". */
export const WRITE_RECENT_MS = 5_000;

// --- BPM bands -------------------------------------------------------------

/** Heartbeat ranges per operating band. Every emitted BPM lands inside one. */
export const BPM_BANDS = {
  /** Resting: healthy and quiet. */
  idle: [65, 70],
  /** Light interaction: a user request or a memory lookup in flight. */
  conversation: [72, 78],
  /** The model is thinking (chat completion in flight). */
  reasoning: [80, 88],
  /** Heavy ingestion / learning: pipeline running or graph writes landing. */
  heavy: [90, 95],
} as const;

const STATE_META: Record<VitalityState, { status: VitalityStatus; color: PulseColor }> = {
  idle: { status: "Healthy", color: "green" },
  listening: { status: "Listening", color: "green" },
  searching: { status: "Searching Memory", color: "green" },
  reasoning: { status: "Reasoning", color: "purple" },
  writing: { status: "Writing Memory", color: "orange" },
  error: { status: "Warning", color: "red" },
};

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Position a 0..1 load fraction inside a [lo, hi] band, rounded to an int. */
function bpmInBand(band: readonly [number, number], load: number): number {
  const [lo, hi] = band;
  return Math.round(lo + (hi - lo) * clamp01(load));
}

/**
 * Select the operating state from the signals, most-significant first:
 * error > writing/ingestion > reasoning > searching > listening > idle.
 *
 * Ingestion (`jobsInFlight`) maps to the same heavy "writing" band as graph
 * writes and sits above reasoning: a video mid-transcription (the longest
 * stage, which runs no chat completion) must still read as heavy activity
 * rather than falsely resting at idle.
 */
export function deriveState(s: VitalitySignals): VitalityState {
  if (s.msSinceError < ERROR_ACTIVE_MS) return "error";
  if (
    s.jobsInFlight > 0 ||
    s.memoryWriteInFlight > 0 ||
    s.msSinceMemoryWrite < WRITE_RECENT_MS
  ) {
    return "writing";
  }
  if (s.llmInFlight > 0) return "reasoning";
  if (s.msSinceMemorySearch < SEARCH_ACTIVE_MS) return "searching";
  if (s.activeRequests > 0) return "listening";
  return "idle";
}

function bpmForState(state: VitalityState, s: VitalitySignals): number {
  switch (state) {
    case "idle":
      // A resting heart drifts a touch with baseline load.
      return bpmInBand(BPM_BANDS.idle, s.cpuPercent / 0.5);
    case "listening":
      return bpmInBand(BPM_BANDS.conversation, s.activeRequests / 3);
    case "searching":
      return bpmInBand(BPM_BANDS.conversation, 0.6);
    case "reasoning":
      return bpmInBand(BPM_BANDS.reasoning, s.llmInFlight / 3);
    case "writing":
      return bpmInBand(BPM_BANDS.heavy, (s.jobsInFlight + s.memoryWriteInFlight) / 3);
    case "error":
      // Elevated + stressed: top of the heavy band.
      return bpmInBand(BPM_BANDS.heavy, 1);
  }
}

/**
 * 0..100 HEALTH index (not activity). A healthy, idle system reads 100; an
 * active error signal or extreme *sustained* CPU/RAM pressure erode it. Normal
 * activity does not reduce it — busyness is expressed by the state/BPM/color.
 */
export function computeVitalityScore(s: VitalitySignals): number {
  const errorPenalty = s.msSinceError < ERROR_ACTIVE_MS ? 0.6 : 0;
  const cpuPenalty = 0.2 * clamp01((s.cpuPercent - 0.85) / 0.15);
  const memPenalty = 0.2 * clamp01((s.memPercent - 0.9) / 0.1);
  const health = clamp01(1 - errorPenalty - cpuPenalty - memPenalty);
  return Math.round(health * 100);
}

/** Fully-determined snapshot for a set of signals. */
export function computeSnapshot(s: VitalitySignals): VitalitySnapshot {
  const state = deriveState(s);
  const meta = STATE_META[state];
  return {
    vitalityScore: computeVitalityScore(s),
    state,
    status: meta.status,
    heartbeatBPM: bpmForState(state, s),
    pulseColor: meta.color,
  };
}
