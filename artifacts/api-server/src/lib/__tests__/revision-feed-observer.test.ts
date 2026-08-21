import { describe, expect, it, vi } from "vitest";
import { INITIAL_AUTHORITY_SOURCES } from "../code-authority.js";
import { createRevisionFeedFingerprintObserver } from "../revision-feed-observer.js";

const baseFeed = INITIAL_AUTHORITY_SOURCES.find(
  ({ sourceType }) => sourceType === "revision_feed",
)!;

function headResponse(etag: string): Response {
  return new Response(null, {
    status: 200,
    headers: { etag },
  });
}

describe("revision-feed HEAD observation cache", () => {
  it("uses a fresh cache hit without another HEAD request", async () => {
    const fetchFn = vi.fn(async () => headResponse('"stable"'));
    const observe = createRevisionFeedFingerprintObserver({
      fetchFn: fetchFn as typeof fetch,
      cacheTtlMs: 60_000,
      timeoutMs: 321,
    });

    await expect(observe(baseFeed)).resolves.toBe(
      'etag:"stable"|last-modified:',
    );
    await expect(observe(baseFeed)).resolves.toBe(
      'etag:"stable"|last-modified:',
    );
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn).toHaveBeenCalledWith(baseFeed.sourceUrl, {
      method: "HEAD",
      redirect: "follow",
      signal: expect.any(AbortSignal),
    });
  });

  it("refreshes the validator after cache expiry", async () => {
    let now = 1_000;
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(headResponse('"first"'))
      .mockResolvedValueOnce(headResponse('"second"'));
    const observe = createRevisionFeedFingerprintObserver({
      fetchFn: fetchFn as typeof fetch,
      cacheTtlMs: 100,
      now: () => now,
    });

    await expect(observe(baseFeed)).resolves.toContain('etag:"first"');
    now += 101;
    await expect(observe(baseFeed)).resolves.toContain('etag:"second"');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("fails closed on a network error after expiry without using stale success", async () => {
    let now = 1_000;
    const failure = new Error("synthetic HEAD failure");
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(headResponse('"verified"'))
      .mockRejectedValueOnce(failure);
    const observe = createRevisionFeedFingerprintObserver({
      fetchFn: fetchFn as typeof fetch,
      cacheTtlMs: 100,
      now: () => now,
    });

    await expect(observe(baseFeed)).resolves.toContain('etag:"verified"');
    now += 101;
    await expect(observe(baseFeed)).rejects.toThrow("synthetic HEAD failure");
    await expect(observe(baseFeed)).rejects.toThrow("synthetic HEAD failure");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("does not share cache entries across jurisdictions", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(headResponse('"bc"'))
      .mockResolvedValueOnce(headResponse('"vancouver"'));
    const observe = createRevisionFeedFingerprintObserver({
      fetchFn: fetchFn as typeof fetch,
    });
    const vancouverFeed = {
      ...baseFeed,
      jurisdiction: "VANCOUVER" as const,
    };

    await expect(observe(baseFeed)).resolves.toContain('etag:"bc"');
    await expect(observe(vancouverFeed)).resolves.toContain('etag:"vancouver"');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
