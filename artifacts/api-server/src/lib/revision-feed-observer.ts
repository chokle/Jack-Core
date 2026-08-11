import type { AuthoritativeSource } from "./code-authority.js";

export const DEFAULT_REVISION_FEED_CACHE_TTL_MS = 60_000;
export const DEFAULT_REVISION_FEED_HEAD_TIMEOUT_MS = 3_000;

interface CachedObservation {
  expiresAt: number;
  fingerprint: string | null;
  error: Error | null;
}

interface RevisionFeedObserverOptions {
  cacheTtlMs?: number;
  fetchFn?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

function configuredPositiveInteger(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function observationKey(source: AuthoritativeSource): string {
  return [source.jurisdiction, source.sourceId, source.sourceUrl].join(
    "\u0000",
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Creates a bounded HEAD-only validator observer. Successful and failed
 * observations are cached for 60 seconds by default, and the timeout defaults
 * to 3 seconds. Expired success entries are discarded before revalidation, so
 * a failed refresh never falls back to stale authorization state.
 */
export function createRevisionFeedFingerprintObserver(
  options: RevisionFeedObserverOptions = {},
): (source: AuthoritativeSource) => Promise<string | null> {
  const cache = new Map<string, CachedObservation>();
  const cacheTtlMs =
    options.cacheTtlMs ??
    configuredPositiveInteger(
      process.env["REVISION_FEED_CACHE_TTL_MS"],
      DEFAULT_REVISION_FEED_CACHE_TTL_MS,
    );
  const fetchFn = options.fetchFn;
  const now = options.now ?? Date.now;
  const timeoutMs =
    options.timeoutMs ??
    configuredPositiveInteger(
      process.env["REVISION_FEED_HEAD_TIMEOUT_MS"],
      DEFAULT_REVISION_FEED_HEAD_TIMEOUT_MS,
    );

  return async (source) => {
    const key = observationKey(source);
    const currentTime = now();
    const cached = cache.get(key);
    if (cached && cached.expiresAt > currentTime) {
      if (cached.error) throw cached.error;
      return cached.fingerprint;
    }
    cache.delete(key);

    try {
      const response = await (fetchFn ?? globalThis.fetch)(source.sourceUrl, {
        method: "HEAD",
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new Error(`Revision feed HEAD returned ${response.status}`);
      }
      const etag = response.headers.get("etag")?.trim() || null;
      const lastModified =
        response.headers.get("last-modified")?.trim() || null;
      const fingerprint =
        etag || lastModified
          ? `etag:${etag ?? ""}|last-modified:${lastModified ?? ""}`
          : null;
      cache.set(key, {
        expiresAt: currentTime + cacheTtlMs,
        fingerprint,
        error: null,
      });
      return fingerprint;
    } catch (error) {
      const failure = asError(error);
      cache.set(key, {
        expiresAt: currentTime + cacheTtlMs,
        fingerprint: null,
        error: failure,
      });
      throw failure;
    }
  };
}
