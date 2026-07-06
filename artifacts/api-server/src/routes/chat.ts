import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { chatCompletion, createEmbedding, MODELS } from "../lib/openai.js";
import { publish } from "../lib/vitality.js";
import { AskJackBody } from "@workspace/api-zod";
import { aiQueryLimiter } from "../lib/rate-limit.js";
import { resolveSession } from "../lib/session.js";
import { buildChatSystemPrompt } from "../lib/jurisdiction.js";
import { fetchVerificationCoverage, rerankByVerification } from "../lib/verification-rerank.js";
import { readKnowledgeMeta, type KnowledgeObjectMeta } from "../lib/knowledge-schema.js";

const MAX_MESSAGE_LENGTH = 2000;

const router = Router();

router.post("/chat", aiQueryLimiter, async (req, res) => {
  try {
    const parsed = AskJackBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

    const { message } = parsed.data;

    if (message.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ error: `Message must be ${MAX_MESSAGE_LENGTH} characters or fewer.` });
    }
    // Ownership is the server-derived Clerk user id (set by the app-level
    // requireAuth gate) — never a client-supplied field. It ties this thread to
    // the account so history follows the user across devices/browsers and never
    // leaks to another user on the same device. The HttpOnly session cookie is
    // still resolved so session_id (NOT NULL) stays populated for continuity,
    // but it is NOT the ownership key.
    const userId = req.userId;
    if (!userId) {
      // Should be unreachable behind requireAuth; fail closed rather than write
      // an unowned (globally readable) row.
      return res.status(401).json({ error: "Unauthorized — sign in required." });
    }
    const session = resolveSession(req, res);

    const embedding = await createEmbedding(message);

    const { data: segments, error: rpcError } = await supabase.rpc("match_transcript_segments", {
      query_embedding: embedding,
      match_threshold: 0.5,
      match_count: 8,
      filter_trade: null,
    });
    // Don't silently swallow a vector-search failure as "no internal knowledge" —
    // that would mask a broken RAG path (missing pgvector fn, schema drift) and
    // strip every citation. Log loudly; the request continues with general
    // knowledge so the user still gets an answer.
    if (rpcError) {
      req.log.error({ err: rpcError }, "match_transcript_segments RPC failed");
    }

    // Also search non-video Knowledge Entries (written field notes, sketches,
    // etc.) with the SAME query embedding, so Jack can surface knowledge that
    // never came from a video. Same threshold contract as the transcript search.
    const { data: entries, error: entryError } = await supabase.rpc("match_knowledge_entries", {
      query_embedding: embedding,
      match_threshold: 0.5,
      match_count: 4,
      filter_trade: null,
    });
    if (entryError) {
      req.log.error({ err: entryError }, "match_knowledge_entries RPC failed");
    }

    // Report the RAG lookup to the Vitality Engine ("Searching Memory").
    publish({ type: "memory:search" });

    // Citations carry an optional discriminator: "video" cites a transcript
    // segment; "knowledge" cites a Knowledge Entry (reusing videoTitle/text/
    // thumbnailUrl for the entry's title/snippet/image so the client renders it
    // without a bespoke shape — see the Citation schema in openapi.yaml).
    const citations: Array<{
      videoId: string;
      videoTitle: string;
      startTime: number;
      endTime: number;
      text: string;
      thumbnailUrl: string | null;
      sourceType: "video" | "knowledge";
      entryId?: string;
      verified?: boolean;
      sourceCount?: number;
    }> = [];

    let contextText = "";

    // Steer the retrieved transcript context by reviewer decisions: verified
    // concepts' segments are boosted, rejected concepts' segments are suppressed.
    // This reorders the context Jack reasons over and the citations it returns.
    const rawSegments = (segments ?? []) as Array<Record<string, unknown>>;
    const coverage = await fetchVerificationCoverage(
      rawSegments
        .map((s) => s["video_id"])
        .filter((v): v is string => typeof v === "string"),
    );
    // Keep the full rerank result (not just the item) so we can both order the
    // context by trust and annotate each segment with its trust signal, letting
    // Jack cite how well-corroborated / reviewer-verified a claim is.
    const rankedSegments =
      coverage.length === 0
        ? rawSegments.map((item) => ({
            item,
            verification: "neutral" as const,
            confidence: 0,
            sourceCount: 0,
          }))
        : rerankByVerification(
            rawSegments,
            (s) => ({
              videoId: typeof s["video_id"] === "string" ? (s["video_id"] as string) : "",
              startTime: typeof s["start_time"] === "number" ? (s["start_time"] as number) : 0,
              endTime: typeof s["end_time"] === "number" ? (s["end_time"] as number) : 0,
              score: typeof s["similarity"] === "number" ? (s["similarity"] as number) : 0,
            }),
            coverage,
          );

    for (const { item: seg, verification, sourceCount } of rankedSegments) {
      const trustTag = describeTrust(verification, sourceCount);
      contextText += `[${seg["video_title"] ?? "Video"} @ ${formatTime(seg["start_time"] as number)}${trustTag}]\n${seg["text"]}\n\n`;
      citations.push({
        videoId: seg["video_id"] as string,
        videoTitle: (seg["video_title"] as string) ?? "Unknown",
        startTime: seg["start_time"] as number,
        endTime: seg["end_time"] as number,
        text: seg["text"] as string,
        thumbnailUrl: (seg["thumbnail_url"] as string | null) ?? null,
        sourceType: "video",
        // Surface the trust signal the reranker already computed so the client
        // can badge it. `verified` = a reviewer confirmed a covering concept;
        // `sourceCount` = distinct corroborating videos (client badges ≥2).
        verified: verification === "verified",
        sourceCount,
      });
    }

    const rawEntries = (entries ?? []) as Array<Record<string, unknown>>;
    // The retrieval RPC (match_knowledge_entries) intentionally returns only the
    // fields needed to render a citation — it does NOT return the `metadata` bag
    // that carries a Knowledge Object's trust signal. Fetch that separately for
    // just the matched entries so field-note citations can be badged the same way
    // video citations are. Bounded by the handful of retrieved entries, and a
    // failure here degrades to un-badged (still-answered) rather than failing the
    // request — trust is an enhancement, never a hard dependency of answering.
    const entryIds = rawEntries
      .map((e) => e["id"])
      .filter((id): id is string => typeof id === "string" && !!id);
    const metaByEntryId = new Map<string, KnowledgeObjectMeta>();
    if (entryIds.length > 0) {
      const { data: metaRows, error: metaError } = await supabase
        .from("knowledge_entries")
        .select("id, metadata")
        .in("id", entryIds);
      if (metaError) {
        req.log.error({ err: metaError }, "knowledge_entries metadata fetch failed; skipping field-note trust");
      } else {
        for (const row of (metaRows ?? []) as Array<Record<string, unknown>>) {
          const id = row["id"];
          if (typeof id === "string") metaByEntryId.set(id, readKnowledgeMeta(row["metadata"]));
        }
      }
    }

    for (const e of rawEntries) {
      const title = (e["title"] as string) ?? "Knowledge Entry";
      const description = (e["description"] as string) ?? "";
      const body = (e["body"] as string) ?? "";
      const images = Array.isArray(e["images"]) ? (e["images"] as Array<Record<string, unknown>>) : [];
      const imageUrl = (images[0]?.["url"] as string | undefined) ?? null;
      const snippet = (description || body).replace(/\s+/g, " ").trim().slice(0, 240);
      const entryId = e["id"] as string;
      // Surface the field note's OWN trust signal (verifiedBy / evidenceCount from
      // its Knowledge Object metadata), mirroring how video citations carry the
      // reranker's verified/sourceCount. A genuinely neutral note (no verifier, no
      // corroboration) sends neither field, so the client leaves it un-badged.
      const trust = knowledgeEntryTrust(metaByEntryId.get(entryId));
      contextText += `[Knowledge Entry: ${title}${describeTrust(
        trust.verified ? "verified" : "neutral",
        trust.sourceCount ?? 0,
      )}]\n${description ? description + "\n" : ""}${body}\n\n`;
      citations.push({
        // No video to jump to — videoId is empty; entryId identifies the source.
        videoId: "",
        videoTitle: title,
        startTime: 0,
        endTime: 0,
        text: snippet,
        thumbnailUrl: imageUrl,
        sourceType: "knowledge",
        entryId,
        // Only set when meaningful — knowledgeEntryTrust omits neutral signals.
        ...(trust.verified ? { verified: true } : {}),
        ...(trust.sourceCount !== undefined ? { sourceCount: trust.sourceCount } : {}),
      });
    }

    const usedInternalKnowledge = citations.length > 0;

    const systemPrompt = buildChatSystemPrompt({ usedInternalKnowledge, contextText });

    const { data: history } = await supabase
      .from("chat_messages")
      .select("role, content")
      .eq("user_id", userId)
      .order("created_at", { ascending: true })
      .limit(10);

    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: systemPrompt },
      ...((history ?? []) as Array<{ role: "user" | "assistant"; content: string }>),
      { role: "user", content: message },
    ];

    const completion = await chatCompletion({
      model: MODELS.chat,
      messages,
      max_tokens: 1024,
    });

    const answer = completion.choices[0]?.message?.content ?? "I wasn't able to generate a response.";

    await supabase.from("chat_messages").insert([
      { session_id: session, user_id: userId, role: "user", content: message, citations: [] },
      { session_id: session, user_id: userId, role: "assistant", content: answer, citations },
    ]);

    return res.json({ answer, citations, usedInternalKnowledge });
  } catch (err) {
    req.log.error({ err }, "askJack error");
    return res.status(500).json({ error: "Jack encountered an error" });
  }
});

router.get("/chat/history", async (req, res) => {
  try {
    // History is scoped to the signed-in account (server-derived Clerk user id),
    // so it follows the user across devices and never leaks to another user on
    // the same device. Fail closed: with no resolvable user (unreachable behind
    // requireAuth), return nothing rather than any global/other-user rows.
    const userId = req.userId;
    if (!userId) return res.json([]);

    const { data, error } = await supabase
      .from("chat_messages")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: true })
      .limit(50);

    if (error) throw error;
    return res.json(
      (data ?? []).map((m: Record<string, unknown>) => ({
        id: m["id"],
        // Ownership fields (session_id / user_id) are intentionally omitted —
        // they are server-side identity, never echoed back into the response.
        role: m["role"],
        content: m["content"],
        citations: m["citations"] ?? [],
        createdAt: m["created_at"],
      }))
    );
  } catch (err) {
    req.log.error({ err }, "getChatHistory error");
    return res.status(500).json({ error: "Failed to get chat history" });
  }
});

router.delete("/chat/history", async (req, res) => {
  try {
    // Same ownership rule as history reads/writes: only the server-derived
    // Clerk user id, never a client-supplied field. Fail closed rather than
    // deleting/matching on anything broader than "this account's own rows".
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized — sign in required." });

    const { error } = await supabase.from("chat_messages").delete().eq("user_id", userId);
    if (error) throw error;

    return res.status(204).end();
  } catch (err) {
    req.log.error({ err }, "clearChatHistory error");
    return res.status(500).json({ error: "Failed to clear chat history" });
  }
});

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Render a short, human-readable trust tag for a retrieved segment so the model
 * can optionally cite how trustworthy the claim is. Returns "" when there is no
 * signal worth surfacing (a lone, unreviewed mention), keeping the context clean.
 */
export function describeTrust(verification: "verified" | "rejected" | "neutral", sourceCount: number): string {
  const parts: string[] = [];
  if (verification === "verified") parts.push("mentor-verified");
  if (sourceCount >= 2) parts.push(`confirmed across ${sourceCount} videos`);
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

/**
 * Derive a field note's (Knowledge Entry's) trust signal for a chat citation.
 *
 * Unlike video citations — whose trust comes from the graph reranker — a
 * Knowledge Object carries its OWN trust in its `metadata` bag:
 *   - `verifiedBy` (who/what confirmed it) → `verified: true` (the mentor-verified
 *     badge), and
 *   - `evidenceCount` (independent pieces of evidence backing it) → `sourceCount`,
 *     which the client badges only at >= 2 ("confirmed across N …").
 *
 * A genuinely neutral note — no verifier, no corroboration — returns an empty
 * object so the route omits both fields and the client leaves it un-badged.
 * Missing/malformed metadata is treated as neutral (never fabricated trust).
 */
export function knowledgeEntryTrust(
  meta: KnowledgeObjectMeta | undefined,
): { verified?: boolean; sourceCount?: number } {
  if (!meta) return {};
  const result: { verified?: boolean; sourceCount?: number } = {};

  const verifiedBy = meta.verifiedBy;
  const hasVerifier = Array.isArray(verifiedBy)
    ? verifiedBy.some((v) => typeof v === "string" && v.trim().length > 0)
    : typeof verifiedBy === "string" && verifiedBy.trim().length > 0;
  if (hasVerifier) result.verified = true;

  const evidenceCount = meta.evidenceCount;
  if (typeof evidenceCount === "number" && Number.isFinite(evidenceCount) && evidenceCount >= 2) {
    result.sourceCount = Math.floor(evidenceCount);
  }

  return result;
}

export default router;
