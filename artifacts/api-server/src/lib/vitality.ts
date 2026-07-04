/**
 * vitality — Jack's in-process Vitality Engine.
 *
 * A tiny publish/subscribe telemetry bus with rolling counters/gauges that any
 * subsystem can push events to (LLM inferences, memory searches, graph writes,
 * ingestion jobs, API requests, errors). `readSignals()` is a cheap, synchronous
 * snapshot of those gauges — no DB, no OpenAI, no allocation of note — which the
 * pure `vitality-score` module turns into the coarse Systems Health snapshot the
 * heartbeat widget renders.
 *
 * Design rules:
 *  - `publish()` NEVER throws: telemetry must never be able to break a real
 *    request or job. It also swallows subscriber errors.
 *  - Every in-flight counter is decremented via `dec()` (clamped at 0) so a
 *    stray "end" can never drive a gauge negative.
 *  - The CPU/RAM sampler is started explicitly (`startVitalitySampler()` from the
 *    server entrypoint), never on import, so importing this module in a test
 *    never spins up a timer.
 */

import os from "node:os";
import { logger } from "./logger.js";
import {
  computeSnapshot,
  type VitalitySignals,
  type VitalitySnapshot,
} from "./vitality-score.js";

export type VitalityEvent =
  | { type: "llm:start" }
  | { type: "llm:end" }
  | { type: "memory:search" }
  | { type: "memory:write:start" }
  | { type: "memory:write:end" }
  | { type: "job:start" }
  | { type: "job:end" }
  | { type: "request:start" }
  | { type: "request:end" }
  | { type: "error" };

interface Counters {
  llmInFlight: number;
  memoryWriteInFlight: number;
  jobsInFlight: number;
  activeRequests: number;
  lastMemorySearchAt: number; // epoch ms; 0 = never
  lastMemoryWriteAt: number;
  lastErrorAt: number;
  cpuPercent: number;
  memPercent: number;
}

const counters: Counters = {
  llmInFlight: 0,
  memoryWriteInFlight: 0,
  jobsInFlight: 0,
  activeRequests: 0,
  lastMemorySearchAt: 0,
  lastMemoryWriteAt: 0,
  lastErrorAt: 0,
  cpuPercent: 0,
  memPercent: 0,
};

type Listener = (event: VitalityEvent) => void;
const listeners = new Set<Listener>();

/** Decrement without ever going negative. */
function dec(n: number): number {
  return n > 0 ? n - 1 : 0;
}

/**
 * Push a telemetry event into the engine. Never throws.
 */
export function publish(event: VitalityEvent): void {
  try {
    switch (event.type) {
      case "llm:start":
        counters.llmInFlight++;
        break;
      case "llm:end":
        counters.llmInFlight = dec(counters.llmInFlight);
        break;
      case "memory:search":
        counters.lastMemorySearchAt = Date.now();
        break;
      case "memory:write:start":
        counters.memoryWriteInFlight++;
        break;
      case "memory:write:end":
        counters.memoryWriteInFlight = dec(counters.memoryWriteInFlight);
        counters.lastMemoryWriteAt = Date.now();
        break;
      case "job:start":
        counters.jobsInFlight++;
        break;
      case "job:end":
        counters.jobsInFlight = dec(counters.jobsInFlight);
        break;
      case "request:start":
        counters.activeRequests++;
        break;
      case "request:end":
        counters.activeRequests = dec(counters.activeRequests);
        break;
      case "error":
        counters.lastErrorAt = Date.now();
        break;
    }
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // A subscriber must never break publish.
      }
    }
  } catch (err) {
    try {
      logger.warn({ err }, "vitality publish failed");
    } catch {
      // Even logging must never throw out of telemetry.
    }
  }
}

/** Subscribe to raw events. Returns an unsubscribe function. */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function msSince(ts: number): number {
  return ts > 0 ? Date.now() - ts : Number.POSITIVE_INFINITY;
}

/** Cheap synchronous snapshot of the current gauges. */
export function readSignals(): VitalitySignals {
  return {
    llmInFlight: counters.llmInFlight,
    memoryWriteInFlight: counters.memoryWriteInFlight,
    jobsInFlight: counters.jobsInFlight,
    activeRequests: counters.activeRequests,
    msSinceMemorySearch: msSince(counters.lastMemorySearchAt),
    msSinceMemoryWrite: msSince(counters.lastMemoryWriteAt),
    msSinceError: msSince(counters.lastErrorAt),
    cpuPercent: counters.cpuPercent,
    memPercent: counters.memPercent,
  };
}

/** Current Systems Health snapshot (the five coarse fields the widget reads). */
export function readSnapshot(): VitalitySnapshot {
  return computeSnapshot(readSignals());
}

// --- instrumentation helpers ----------------------------------------------

/**
 * Wrap a promise-returning LLM call with matched llm:start/end (end always
 * fires, even on throw). A rejection also emits an `error` signal — a genuine
 * inference/API failure should surface as a brief Warning.
 */
export async function trackInference<T>(fn: () => Promise<T>): Promise<T> {
  publish({ type: "llm:start" });
  try {
    return await fn();
  } catch (err) {
    publish({ type: "error" });
    throw err;
  } finally {
    publish({ type: "llm:end" });
  }
}

/**
 * Wrap a knowledge-graph write with matched memory:write:start/end. A rejection
 * emits an `error` signal (a failed knowledge write is a real system error).
 */
export async function trackMemoryWrite<T>(fn: () => Promise<T>): Promise<T> {
  publish({ type: "memory:write:start" });
  try {
    return await fn();
  } catch (err) {
    publish({ type: "error" });
    throw err;
  } finally {
    publish({ type: "memory:write:end" });
  }
}

/** Wrap an ingestion pipeline run with matched job:start/end. */
export async function trackJob<T>(fn: () => Promise<T>): Promise<T> {
  publish({ type: "job:start" });
  try {
    return await fn();
  } finally {
    publish({ type: "job:end" });
  }
}

// --- resource sampler ------------------------------------------------------

let samplerTimer: ReturnType<typeof setInterval> | null = null;
let lastCpu = process.cpuUsage();
let lastCpuAt = Date.now();

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function sampleResources(): void {
  const now = Date.now();
  const elapsedMs = now - lastCpuAt;
  const cpu = process.cpuUsage(lastCpu); // microseconds since lastCpu
  lastCpu = process.cpuUsage();
  lastCpuAt = now;

  if (elapsedMs > 0) {
    const usedMs = (cpu.user + cpu.system) / 1000;
    const cores = Math.max(1, os.cpus()?.length ?? 1);
    counters.cpuPercent = clamp01(usedMs / elapsedMs / cores);
  }

  const rss = process.memoryUsage().rss;
  const total = os.totalmem() || rss;
  counters.memPercent = clamp01(rss / total);
}

/**
 * Start periodic CPU/RAM sampling. Idempotent; the interval is unref'd so it
 * never keeps the process alive. Call once from the server entrypoint.
 */
export function startVitalitySampler(intervalMs = 2000): () => void {
  if (samplerTimer) return () => {};
  lastCpu = process.cpuUsage();
  lastCpuAt = Date.now();
  samplerTimer = setInterval(() => {
    try {
      sampleResources();
    } catch (err) {
      logger.warn({ err }, "vitality resource sampler failed");
    }
  }, intervalMs);
  samplerTimer.unref?.();
  return () => {
    if (samplerTimer) {
      clearInterval(samplerTimer);
      samplerTimer = null;
    }
  };
}
