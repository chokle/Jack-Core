import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { createEmbedding } from "../lib/openai.js";
import { publish } from "../lib/vitality.js";
import { SemanticSearchBody } from "@workspace/api-zod";
import { aiQueryLimiter } from "../lib/rate-limit.js";
import { fetchVerificationCoverage, rerankByVerification } from "../lib/verification-rerank.js";

interface SearchResult {
  videoId: unknown;
  videoTitle: unknown;
  thumbnailUrl: unknown;
  text: unknown;
  startTime: unknown;
  endTime: unknown;
  score: number;
  trade: unknown;
}

/**
 * Re-rank raw search results by reviewer decisions: verified concepts' segments
 * are boosted, rejected concepts' segments are suppressed. The adjusted score is
 * written back so the client's ordering and displayed relevance both reflect it.
 */
async function applyVerificationRerank(results: SearchResult[]): Promise<SearchResult[]> {
  if (results.length === 0) return results;
  const coverage = await fetchVerificationCoverage(
    results.map((r) => r.videoId).filter((v): v is string => typeof v === "string"),
  );
  if (coverage.length === 0) return results;
  return rerankByVerification(
    results,
    (r) => ({
      videoId: typeof r.videoId === "string" ? r.videoId : "",
      startTime: typeof r.startTime === "number" ? r.startTime : 0,
      endTime: typeof r.endTime === "number" ? r.endTime : 0,
      score: r.score,
    }),
    coverage,
  ).map((r) => ({ ...r.item, score: r.score }));
}

const router = Router();

const MAX_QUERY_LENGTH = 500;
const MAX_SEARCH_LIMIT = 50;

router.post("/search", aiQueryLimiter, async (req, res) => {
  try {
    const parsed = SemanticSearchBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

    const { query, trade } = parsed.data;
    const limit = Math.min(parsed.data.limit ?? 10, MAX_SEARCH_LIMIT);

    if (query.length > MAX_QUERY_LENGTH) {
      return res.status(400).json({ error: `Query must be ${MAX_QUERY_LENGTH} characters or fewer.` });
    }

    const embedding = await createEmbedding(query);

    const { data: segments, error } = await supabase.rpc("match_transcript_segments", {
      query_embedding: embedding,
      match_threshold: 0.5,
      match_count: limit,
      filter_trade: trade ?? null,
    });
    // Report the RAG lookup to the Vitality Engine ("Searching Memory").
    publish({ type: "memory:search" });

    if (error || !segments?.length) {
      const { data: textResults } = await supabase
        .from("transcript_segments")
        .select("id, video_id, start_time, end_time, text, videos(id, title, thumbnail_url, trade)")
        .ilike("text", `%${query}%`)
        .limit(limit);

      const results = (textResults ?? []).map((s: Record<string, unknown>) => {
        const video = s["videos"] as Record<string, unknown> | null;
        return {
          videoId: s["video_id"],
          videoTitle: video?.["title"] ?? "Unknown",
          thumbnailUrl: video?.["thumbnail_url"] ?? null,
          text: s["text"],
          startTime: s["start_time"],
          endTime: s["end_time"],
          score: 0.5,
          trade: video?.["trade"] ?? null,
        };
      });

      return res.json({ query, results: await applyVerificationRerank(results) });
    }

    const results = (segments ?? []).map((s: Record<string, unknown>) => ({
      videoId: s["video_id"],
      videoTitle: s["video_title"] ?? "Unknown",
      thumbnailUrl: s["thumbnail_url"] ?? null,
      text: s["text"],
      startTime: s["start_time"],
      endTime: s["end_time"],
      score: (s["similarity"] as number) ?? 0,
      trade: s["trade"] ?? null,
    }));

    return res.json({ query, results: await applyVerificationRerank(results) });
  } catch (err) {
    req.log.error({ err }, "semanticSearch error");
    return res.status(500).json({ error: "Search failed" });
  }
});

export default router;
