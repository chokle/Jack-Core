/**
 * verification-rerank — let concept trust (reviewer decisions + corroboration)
 * steer what Ask Jack and semantic search surface.
 *
 * Retrieval runs over `transcript_segments` (pgvector), which have no trust signal
 * of their own. Trust lives on the distilled concept nodes (`knowledge_nodes`):
 *   - `verification_status` — a human reviewer's verified/rejected decision.
 *   - `confidence` — the corroboration-derived noisy-OR score (many independent
 *     source videos push it toward 1; a one-off mention stays weak).
 *   - `meta.sources` — the source videos + timestamps where the concept was taught.
 * We map that provenance back onto retrieved segments by (videoId, time-window)
 * overlap and then:
 *   - SUPPRESS (drop) a segment covered only by rejected concept(s),
 *   - BOOST a segment covered by a verified concept (a fixed reviewer bump), and
 *   - additionally BOOST any covered segment in proportion to the covering
 *     concept's derived confidence and how many videos corroborate it.
 * A verified signal always wins over a rejected one; a reviewer rejection always
 * wins over automatic corroboration. Segments with no covering concept are left
 * untouched (neutral), so this only ever moves content the graph has an opinion
 * about — it never invents a ranking.
 *
 * The scoring/overlap logic is pure and independently testable; only
 * `fetchVerificationCoverage` touches the database.
 */
/** Additive similarity bump applied to a segment covered by a verified concept. */
export const VERIFIED_SCORE_BOOST = 0.15;

/**
 * Maximum additive bump from corroboration alone (i.e. how much a concept
 * confirmed across many videos with high confidence can lift a segment, on top of
 * any verified bump). Kept below VERIFIED_SCORE_BOOST so a human decision remains
 * the strongest signal.
 */
export const CORROBORATION_MAX_BOOST = 0.1;

/**
 * Number of distinct corroborating source videos at which the corroboration bump
 * saturates. Below this it scales linearly; a single-source concept gets nothing
 * (one mention is not corroboration).
 */
export const CORROBORATION_FULL_SOURCES = 3;

/**
 * Tolerance (seconds) applied to both ends of a segment's time window when
 * testing whether a concept's recorded timestamp falls inside it. Concept
 * timestamps and segment boundaries are derived independently, so a small pad
 * absorbs rounding drift without letting one concept bleed across the whole video.
 */
const TIMESTAMP_PAD_SECONDS = 2;

/**
 * A concept's trust status as it influences retrieval. `verified`/`rejected` are
 * reviewer decisions; every other stored status (unverified, mentor_supplied, …)
 * collapses to `unverified` — still eligible for a corroboration bump, but never a
 * reviewer bump or a drop.
 */
export type ConceptStatus = "verified" | "rejected" | "unverified";

/** One concept's coverage over a single source video, with its trust signal. */
export interface ConceptCoverage {
  videoId: string;
  timestamps: number[];
  status: ConceptStatus;
  /** Corroboration-derived confidence for the whole concept (0..1). */
  confidence: number;
  /** Distinct source videos corroborating the whole concept. */
  sourceCount: number;
}

/** The strongest verification signal covering a segment's time window. */
export type SegmentVerification = "verified" | "rejected" | "neutral";

/** The full trust signal covering a segment, used for ranking and citation. */
export interface SegmentTrust {
  verification: SegmentVerification;
  /** Derived confidence of the covering concept that set this signal (0 if none). */
  confidence: number;
  /** Distinct corroborating source videos of that concept (0 if none). */
  sourceCount: number;
  /** Additive score adjustment for this segment (0 for neutral-uncovered). */
  boost: number;
}

interface SegmentWindow {
  videoId: string;
  startTime: number;
  endTime: number;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Corroboration bump: reward concepts confirmed by multiple independent videos,
 * scaled by their derived confidence. A single-source concept (sourceCount ≤ 1)
 * gets nothing — one mention is not corroboration. Breadth scales linearly up to
 * CORROBORATION_FULL_SOURCES, where it saturates.
 */
export function corroborationBoost(
  confidence: number,
  sourceCount: number,
): number {
  if (sourceCount <= 1) return 0;
  const breadth = Math.min(
    1,
    (sourceCount - 1) / (CORROBORATION_FULL_SOURCES - 1),
  );
  return CORROBORATION_MAX_BOOST * clamp01(confidence) * breadth;
}

/**
 * Build the concept coverage list from raw `knowledge_nodes` rows, keeping only
 * sources that touch one of the supplied videos. Pure so route and test callers
 * share identical semantics. Unlike a reviewer-only view, this includes
 * unverified concepts too, so their corroboration can still steer ranking; the
 * status field records whether a human weighed in. A concept source with no
 * timestamps cannot be tied to a specific segment and is therefore ignored (we
 * never boost or suppress a whole video off a single node).
 */
export function buildCoverageFromNodes(
  rows: Array<{
    verification_status?: unknown;
    confidence?: unknown;
    meta?: unknown;
  }>,
  videoIds: string[],
): ConceptCoverage[] {
  const wanted = new Set(videoIds);
  const coverage: ConceptCoverage[] = [];
  for (const row of rows) {
    const rawStatus = row.verification_status;
    const status: ConceptStatus =
      rawStatus === "verified"
        ? "verified"
        : rawStatus === "rejected"
          ? "rejected"
          : "unverified";
    const meta = (row.meta ?? {}) as Record<string, unknown>;
    const confidence =
      typeof row.confidence === "number" ? clamp01(row.confidence) : 0;
    const sources = Array.isArray(meta["sources"])
      ? (meta["sources"] as unknown[])
      : [];
    const sourceCount =
      typeof meta["sourceCount"] === "number"
        ? (meta["sourceCount"] as number)
        : sources.length;
    for (const s of sources) {
      const src = (s ?? {}) as Record<string, unknown>;
      const videoId =
        typeof src["videoId"] === "string" ? (src["videoId"] as string) : null;
      if (!videoId || !wanted.has(videoId)) continue;
      const timestamps = Array.isArray(src["timestamps"])
        ? (src["timestamps"] as unknown[]).filter(
            (t): t is number => typeof t === "number",
          )
        : [];
      if (timestamps.length === 0) continue;
      coverage.push({ videoId, timestamps, status, confidence, sourceCount });
    }
  }
  return coverage;
}

/**
 * Classify a segment by the concepts whose timestamps fall inside its (padded)
 * window, returning the full trust signal. Precedence:
 *   1. verified — a reviewer confirmed a covering concept (best-corroborated one
 *      wins if several); carries a reviewer bump plus its corroboration bump.
 *   2. rejected — a reviewer rejected the only covering concept(s); the segment is
 *      marked for suppression (its bump is irrelevant, it will be dropped).
 *   3. unverified — no reviewer weighed in; carries a corroboration-only bump from
 *      the best-corroborated covering concept.
 *   4. neutral — nothing covers the window; left untouched.
 * A reviewer rejection outranks automatic corroboration, but never outranks a
 * verified decision on the same window.
 */
export function segmentTrust(
  segment: SegmentWindow,
  coverage: ConceptCoverage[],
): SegmentTrust {
  let verified: SegmentTrust | null = null;
  let unverified: SegmentTrust | null = null;
  let rejected = false;
  const lo = segment.startTime - TIMESTAMP_PAD_SECONDS;
  const hi = segment.endTime + TIMESTAMP_PAD_SECONDS;
  for (const c of coverage) {
    if (c.videoId !== segment.videoId) continue;
    if (!c.timestamps.some((t) => t >= lo && t <= hi)) continue;
    if (c.status === "verified") {
      const boost =
        VERIFIED_SCORE_BOOST + corroborationBoost(c.confidence, c.sourceCount);
      if (!verified || boost > verified.boost) {
        verified = {
          verification: "verified",
          confidence: c.confidence,
          sourceCount: c.sourceCount,
          boost,
        };
      }
    } else if (c.status === "rejected") {
      rejected = true;
    } else {
      const boost = corroborationBoost(c.confidence, c.sourceCount);
      if (!unverified || boost > unverified.boost) {
        unverified = {
          verification: "neutral",
          confidence: c.confidence,
          sourceCount: c.sourceCount,
          boost,
        };
      }
    }
  }
  if (verified) return verified;
  if (rejected)
    return {
      verification: "rejected",
      confidence: 0,
      sourceCount: 0,
      boost: 0,
    };
  if (unverified) return unverified;
  return { verification: "neutral", confidence: 0, sourceCount: 0, boost: 0 };
}

/**
 * Backward-compatible thin wrapper returning only the coarse verification label
 * for a segment. Prefer `segmentTrust` when the confidence/corroboration signal
 * is needed.
 */
export function segmentVerification(
  segment: SegmentWindow,
  coverage: ConceptCoverage[],
): SegmentVerification {
  return segmentTrust(segment, coverage).verification;
}

/** An item after reranking: rejected items are dropped before this is produced. */
export interface RerankResult<T> {
  item: T;
  /** Original score with any trust boost applied (clamped to [0,1]). */
  score: number;
  verification: SegmentVerification;
  /** Derived confidence of the covering concept (0 if none). */
  confidence: number;
  /** Distinct corroborating source videos of the covering concept (0 if none). */
  sourceCount: number;
}

/**
 * Rerank retrieved items by concept trust: drop segments covered only by rejected
 * concepts, boost those covered by a verified concept and/or corroborated across
 * multiple videos, then sort by the adjusted score (descending). Neutral,
 * uncovered items keep their original score. Sorting is stable for equal scores
 * because we preserve input order on ties.
 */
export function rerankByVerification<T>(
  items: T[],
  accessor: (item: T) => {
    videoId: string;
    startTime: number;
    endTime: number;
    score: number;
  },
  coverage: ConceptCoverage[],
): Array<RerankResult<T>> {
  const kept: Array<RerankResult<T> & { order: number }> = [];
  items.forEach((item, order) => {
    const { videoId, startTime, endTime, score } = accessor(item);
    const trust = segmentTrust({ videoId, startTime, endTime }, coverage);
    if (trust.verification === "rejected") return;
    const adjusted = clamp01(score + trust.boost);
    kept.push({
      item,
      score: adjusted,
      verification: trust.verification,
      confidence: trust.confidence,
      sourceCount: trust.sourceCount,
      order,
    });
  });
  kept.sort((a, b) => b.score - a.score || a.order - b.order);
  return kept.map(({ item, score, verification, confidence, sourceCount }) => ({
    item,
    score,
    verification,
    confidence,
    sourceCount,
  }));
}

/**
 * Load concept trust coverage for the given source videos. Bounded by the handful
 * of retrieved videos rather than the whole graph: first resolve the concepts
 * those videos corroborate via provenance edges, then read those concepts' trust
 * fields. On any DB error we log and return an empty coverage list so retrieval
 * degrades to its un-reranked behavior rather than failing the whole request —
 * trust is an enhancement to ranking, never a hard dependency of answering.
 */
export async function fetchVerificationCoverage(
  videoIds: string[],
): Promise<ConceptCoverage[]> {
  const unique = [
    ...new Set(
      videoIds.filter((v): v is string => typeof v === "string" && !!v),
    ),
  ];
  if (unique.length === 0) return [];

  // Keep the pure reranking helpers importable without database credentials.
  // This function is the module's only infrastructure boundary.
  const [{ supabase }, { logger }] = await Promise.all([
    import("./supabase.js"),
    import("./logger.js"),
  ]);

  const { data: edges, error: edgeError } = await supabase
    .from("knowledge_edges")
    .select("target_id")
    .eq("kind", "knowledge")
    .in(
      "source_id",
      unique.map((v) => `video:${v}`),
    );
  if (edgeError) {
    logger.error(
      { err: edgeError },
      "fetchVerificationCoverage edges failed; skipping rerank",
    );
    return [];
  }
  const conceptIds = [
    ...new Set(
      (edges ?? [])
        .map((e) => (e as Record<string, unknown>)["target_id"])
        .filter((id): id is string => typeof id === "string"),
    ),
  ];
  if (conceptIds.length === 0) return [];

  const { data, error } = await supabase
    .from("knowledge_nodes")
    .select("verification_status, confidence, meta")
    .in("id", conceptIds);
  if (error) {
    logger.error(
      { err: error },
      "fetchVerificationCoverage nodes failed; skipping rerank",
    );
    return [];
  }
  return buildCoverageFromNodes(
    (data ?? []) as Array<{
      verification_status?: unknown;
      confidence?: unknown;
      meta?: unknown;
    }>,
    unique,
  );
}
