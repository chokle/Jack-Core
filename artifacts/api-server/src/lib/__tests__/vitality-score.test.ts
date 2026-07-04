import { describe, it, expect } from "vitest";
import {
  computeSnapshot,
  computeVitalityScore,
  deriveState,
  BPM_BANDS,
  ERROR_ACTIVE_MS,
  SEARCH_ACTIVE_MS,
  WRITE_RECENT_MS,
  type VitalitySignals,
} from "../vitality-score.js";

/** Baseline: a healthy, idle system with no activity of any kind. */
function idle(overrides: Partial<VitalitySignals> = {}): VitalitySignals {
  return {
    llmInFlight: 0,
    memoryWriteInFlight: 0,
    jobsInFlight: 0,
    activeRequests: 0,
    msSinceMemorySearch: Number.POSITIVE_INFINITY,
    msSinceMemoryWrite: Number.POSITIVE_INFINITY,
    msSinceError: Number.POSITIVE_INFINITY,
    cpuPercent: 0,
    memPercent: 0,
    ...overrides,
  };
}

describe("deriveState — priority ordering", () => {
  it("idle when nothing is happening", () => {
    expect(deriveState(idle())).toBe("idle");
  });

  it("background GET polling never leaves idle (only non-GET requests count)", () => {
    // The engine excludes GETs from activeRequests, and graph reads never emit
    // memory:search, so a system doing nothing but serving poll traffic still
    // has activeRequests=0 / msSinceMemorySearch=Infinity → idle stays reachable.
    expect(deriveState(idle())).toBe("idle");
  });

  it("listening when a non-GET request is in flight", () => {
    expect(deriveState(idle({ activeRequests: 1 }))).toBe("listening");
  });

  it("searching when a RAG search is recent, over listening", () => {
    expect(
      deriveState(idle({ activeRequests: 1, msSinceMemorySearch: SEARCH_ACTIVE_MS - 1 })),
    ).toBe("searching");
  });

  it("reasoning when an LLM call is in flight, over searching/listening", () => {
    expect(
      deriveState(
        idle({ llmInFlight: 1, activeRequests: 1, msSinceMemorySearch: 0 }),
      ),
    ).toBe("reasoning");
  });

  it("writing when a graph write is in flight, over reasoning", () => {
    expect(deriveState(idle({ memoryWriteInFlight: 1, llmInFlight: 2 }))).toBe("writing");
  });

  it("writing when a graph write completed very recently", () => {
    expect(deriveState(idle({ msSinceMemoryWrite: WRITE_RECENT_MS - 1 }))).toBe("writing");
  });

  it("ingestion (jobsInFlight) reads as heavy 'writing' even with no LLM/search", () => {
    // A transcribing video runs no chat completion — it must still read heavy.
    expect(deriveState(idle({ jobsInFlight: 1 }))).toBe("writing");
  });

  it("error beats everything", () => {
    const s = idle({
      msSinceError: ERROR_ACTIVE_MS - 1,
      jobsInFlight: 5,
      memoryWriteInFlight: 5,
      llmInFlight: 5,
      activeRequests: 5,
      msSinceMemorySearch: 0,
    });
    expect(deriveState(s)).toBe("error");
  });

  it("a stale error (older than the window) no longer forces error", () => {
    expect(deriveState(idle({ msSinceError: ERROR_ACTIVE_MS + 1 }))).toBe("idle");
  });
});

describe("computeSnapshot — status/color/BPM per state", () => {
  const cases: Array<{
    name: string;
    signals: VitalitySignals;
    state: string;
    status: string;
    color: string;
    band: readonly [number, number];
  }> = [
    { name: "idle", signals: idle(), state: "idle", status: "Healthy", color: "green", band: BPM_BANDS.idle },
    {
      name: "listening",
      signals: idle({ activeRequests: 2 }),
      state: "listening",
      status: "Listening",
      color: "green",
      band: BPM_BANDS.conversation,
    },
    {
      name: "searching",
      signals: idle({ msSinceMemorySearch: 100 }),
      state: "searching",
      status: "Searching Memory",
      color: "green",
      band: BPM_BANDS.conversation,
    },
    {
      name: "reasoning",
      signals: idle({ llmInFlight: 1 }),
      state: "reasoning",
      status: "Reasoning",
      color: "purple",
      band: BPM_BANDS.reasoning,
    },
    {
      name: "writing",
      signals: idle({ jobsInFlight: 1 }),
      state: "writing",
      status: "Writing Memory",
      color: "orange",
      band: BPM_BANDS.heavy,
    },
    {
      name: "error",
      signals: idle({ msSinceError: 0 }),
      state: "error",
      status: "Warning",
      color: "red",
      band: BPM_BANDS.heavy,
    },
  ];

  for (const c of cases) {
    it(`${c.name} → ${c.status} / ${c.color} / BPM in band`, () => {
      const snap = computeSnapshot(c.signals);
      expect(snap.state).toBe(c.state);
      expect(snap.status).toBe(c.status);
      expect(snap.pulseColor).toBe(c.color);
      expect(Number.isInteger(snap.heartbeatBPM)).toBe(true);
      expect(snap.heartbeatBPM).toBeGreaterThanOrEqual(c.band[0]);
      expect(snap.heartbeatBPM).toBeLessThanOrEqual(c.band[1]);
    });
  }

  it("BPM stays within band even for extreme load fractions", () => {
    const snap = computeSnapshot(idle({ jobsInFlight: 999, memoryWriteInFlight: 999 }));
    expect(snap.heartbeatBPM).toBeGreaterThanOrEqual(BPM_BANDS.heavy[0]);
    expect(snap.heartbeatBPM).toBeLessThanOrEqual(BPM_BANDS.heavy[1]);
  });
});

describe("computeVitalityScore — health index", () => {
  it("healthy idle is 100", () => {
    expect(computeVitalityScore(idle())).toBe(100);
  });

  it("normal activity does not reduce health", () => {
    expect(computeVitalityScore(idle({ llmInFlight: 3, jobsInFlight: 2, activeRequests: 4 }))).toBe(100);
  });

  it("an active error reduces health sharply", () => {
    const score = computeVitalityScore(idle({ msSinceError: 0 }));
    expect(score).toBeLessThan(100);
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it("extreme sustained CPU/RAM erodes health", () => {
    expect(computeVitalityScore(idle({ cpuPercent: 1, memPercent: 1 }))).toBeLessThan(100);
  });

  it("stays within 0..100 under worst case", () => {
    const score = computeVitalityScore(idle({ msSinceError: 0, cpuPercent: 1, memPercent: 1 }));
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });
});

describe("determinism", () => {
  it("identical signals produce identical snapshots", () => {
    const s = idle({ llmInFlight: 1, cpuPercent: 0.3 });
    expect(computeSnapshot(s)).toEqual(computeSnapshot(s));
  });
});
