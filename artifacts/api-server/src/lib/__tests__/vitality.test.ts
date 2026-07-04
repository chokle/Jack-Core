import { describe, it, expect } from "vitest";
import { publish, readSignals } from "../vitality.js";

/**
 * The heartbeat widget reads its "busy" state from the in-flight counters the
 * Vitality Engine maintains. Those counters MUST balance: every `request:start`
 * has a matching `request:end`, and a stray/duplicate `end` must never drive a
 * gauge negative. If they drifted, an idle server could read as perpetually
 * busy (or a negative gauge could corrupt the derived state) — so pin the
 * start/end pairing here.
 *
 * The engine keeps a single process-wide counter, so each test measures the
 * DELTA it causes relative to the current value rather than an absolute.
 */

describe("vitality request:start/request:end balance", () => {
  it("returns to baseline after equal starts and ends", () => {
    const base = readSignals().activeRequests;

    publish({ type: "request:start" });
    publish({ type: "request:start" });
    publish({ type: "request:start" });
    expect(readSignals().activeRequests).toBe(base + 3);

    publish({ type: "request:end" });
    publish({ type: "request:end" });
    publish({ type: "request:end" });
    expect(readSignals().activeRequests).toBe(base);
  });

  it("never lets a stray end drive the gauge negative (idle never reads busy)", () => {
    // Drain to a known-balanced state first, then over-end.
    let guard = 0;
    while (readSignals().activeRequests > 0 && guard++ < 100) {
      publish({ type: "request:end" });
    }
    expect(readSignals().activeRequests).toBe(0);

    publish({ type: "request:end" });
    publish({ type: "request:end" });
    expect(readSignals().activeRequests).toBe(0);
  });

  it("clears back to zero even if ends outnumber starts", () => {
    const base = readSignals().activeRequests;

    publish({ type: "request:start" });
    publish({ type: "request:end" });
    publish({ type: "request:end" }); // stray extra end
    publish({ type: "request:end" }); // another stray

    // One start, one legit end → back to base; the strays are clamped at 0.
    expect(readSignals().activeRequests).toBe(Math.max(0, base));
  });
});
