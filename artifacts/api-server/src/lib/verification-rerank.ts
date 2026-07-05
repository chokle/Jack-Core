/**
 * verification-rerank — let reviewer decisions on distilled concepts steer what
 * Ask Jack and semantic search surface.
 *
 * Retrieval runs over `transcript_segments` (pgvector), which have no verification
 * status of their own. Human review, however, lives on the distilled concept nodes
 * (`knowledge_nodes.verification_status`). Each verified/rejected concept records
 * its provenance in `meta.sources` — the source videos and the timestamps where it
 * was taught. We map that provenance back onto retrieved segments by (videoId,
 * time-window) overlap and then:
 *   - BOOST a segment covered by a verified concept, and
 *   - SUPPRESS (drop) a segment covered only by rejected concept(s).
 * A verified signal always wins over a rejected one for the same segment. Segments
 * with no reviewed concept over their window are left untouched (neutral), so this
 * only ever moves human-judged content — it never invents a ranking.
 *
 * The scoring/overlap logic is pure and independently testable; only
 * `fetchVerificationCoverage` touches the database.
 */
import { supabase } from "./supabase.js";
import { logger } from "./logger.js";

/** Additive similarity bump applied to a segment covered by a verified concept. */
export const VERIFIED_SCORE_BOOST = 0.15;

/**
 * Tolerance (seconds) applied to both ends of a segment's time window when
 * testing whether a concept's recorded timestamp falls inside it. Concept
 * timestamps and segment boundaries are derived independently, so a small pad
 * absorbs rounding drift without letting one concept bleed across the whole video.
 */
const TIMESTAMP_PAD_SECONDS = 2;

/** The two reviewer decisions that influence retrieval. `unverified`/`mentor_supplied` do not. */
export type ConceptStatus = "verified" | "rejected";

/** One reviewed concept's coverage over a single source video. */
export interface ConceptCoverage {
  videoId: string;
  timestamps: number[];
  status: ConceptStatus;
}

/** The strongest verification signal covering a segment's time window. */
export type SegmentVerification = "verified" | "rejected" | "neutral";

interface SegmentWindow {
  videoId: string;
  startTime: number;
  endTime: number;
}

/**
 * Build the reviewed-concept coverage list from raw `knowledge_nodes` rows,
 * keeping only sources that touch one of the supplied videos. Pure so route and
 * test callers share identical semantics. A concept source with no timestamps
 * cannot be tied to a specific segment and is therefore ignored (we never boost
 * or suppress a whole video off a single node).
 */
export function buildCoverageFromNodes(
  rows: Array<{ verification_status?: unknown; meta?: unknown }>,
  videoIds: string[],
): ConceptCoverage[] {
  const wanted = new Set(videoIds);
  const coverage: ConceptCoverage[] = [];
  for (const row of rows) {
    const status = row.verification_status;
    if (status !== "verified" && status !== "rejected") continue;
    const meta = (row.meta ?? {}) as Record<string, unknown>;
    const sources = Array.isArray(meta["sources"]) ? (meta["sources"] as unknown[]) : [];
    for (const s of sources) {
      const src = (s ?? {}) as Record<string, unknown>;
      const videoId = typeof src["videoId"] === "string" ? (src["videoId"] as string) : null;
      if (!videoId || !wanted.has(videoId)) continue;
      const timestamps = Array.isArray(src["timestamps"])
        ? (src["timestamps"] as unknown[]).filter((t): t is number => typeof t === "number")
        : [];
      if (timestamps.length === 0) continue;
      coverage.push({ videoId, timestamps, status });
    }
  }
  return coverage;
}

/**
 * Classify a segment by the reviewed concepts whose timestamps fall inside its
 * (padded) window. A verified hit wins immediately; otherwise a rejected hit
 * marks the segment rejected; no hit is neutral.
 */
export function segmentVerification(
  segment: SegmentWindow,
  coverage: ConceptCoverage[],
): SegmentVerification {
  let rejected = false;
  const lo = segment.startTime - TIMESTAMP_PAD_SECONDS;
  const hi = segment.endTime + TIMESTAMP_PAD_SECONDS;
  for (const c of coverage) {
    if (c.videoId !== segment.videoId) continue;
    if (!c.timestamps.some((t) => t >= lo && t <= hi)) continue;
    if (c.status === "verified") return "verified";
    rejected = true;
  }
  return rejected ? "rejected" : "neutral";
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** An item after reranking: rejected items are dropped before this is produced. */
export interface RerankResult<T> {
  item: T;
  /** Original score with the verified boost applied (clamped to [0,1]). */
  score: number;
  verification: SegmentVerification;
}

/**
 * Rerank retrieved items by reviewer decisions: drop segments covered only by
 * rejected concepts, boost those covered by a verified concept, then sort by the
 * adjusted score (descending). Neutral items keep their original score. Sorting is
 * stable-enough for equal scores because we preserve input order on ties.
 */
export function rerankByVerification<T>(
  items: T[],
  accessor: (item: T) => { videoId: string; startTime: number; endTime: number; score: number },
  coverage: ConceptCoverage[],
): Array<RerankResult<T>> {
  const kept: Array<RerankResult<T> & { order: number }> = [];
  items.forEach((item, order) => {
    const { videoId, startTime, endTime, score } = accessor(item);
    const verification = segmentVerification({ videoId, startTime, endTime }, coverage);
    if (verification === "rejected") return;
    const adjusted = verification === "verified" ? clamp01(score + VERIFIED_SCORE_BOOST) : score;
    kept.push({ item, score: adjusted, verification, order });
  });
  kept.sort((a, b) => b.score - a.score || a.order - b.order);
  return kept.map(({ item, score, verification }) => ({ item, score, verification }));
}

/**
 * Load reviewed-concept coverage for the given source videos. On any DB error we
 * log and return an empty coverage list so retrieval degrades to its un-reranked
 * behavior rather than failing the whole request — reviewer decisions are an
 * enhancement to ranking, never a hard dependency of answering.
 */
export async function fetchVerificationCoverage(videoIds: string[]): Promise<ConceptCoverage[]> {
  const unique = [...new Set(videoIds.filter((v): v is string => typeof v === "string" && !!v))];
  if (unique.length === 0) return [];
  const { data, error } = await supabase
    .from("knowledge_nodes")
    .select("verification_status, meta")
    .in("verification_status", ["verified", "rejected"]);
  if (error) {
    logger.error({ err: error }, "fetchVerificationCoverage failed; skipping rerank");
    return [];
  }
  return buildCoverageFromNodes(
    (data ?? []) as Array<{ verification_status?: unknown; meta?: unknown }>,
    unique,
  );
}
