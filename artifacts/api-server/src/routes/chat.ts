import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { chatCompletion, createEmbedding, MODELS } from "../lib/openai.js";
import { publish } from "../lib/vitality.js";
import { AskJackBody } from "@workspace/api-zod";
import { aiQueryLimiter } from "../lib/rate-limit.js";
import { SESSION_COOKIE, resolveSession } from "../lib/session.js";

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
    // Session identity is owned by the server via an HttpOnly cookie.
    // Any sessionId the client may have included in the body is ignored.
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
    }> = [];

    let contextText = "";

    for (const seg of (segments ?? []) as Array<Record<string, unknown>>) {
      contextText += `[${seg["video_title"] ?? "Video"} @ ${formatTime(seg["start_time"] as number)}]\n${seg["text"]}\n\n`;
      citations.push({
        videoId: seg["video_id"] as string,
        videoTitle: (seg["video_title"] as string) ?? "Unknown",
        startTime: seg["start_time"] as number,
        endTime: seg["end_time"] as number,
        text: seg["text"] as string,
        thumbnailUrl: (seg["thumbnail_url"] as string | null) ?? null,
        sourceType: "video",
      });
    }

    for (const e of (entries ?? []) as Array<Record<string, unknown>>) {
      const title = (e["title"] as string) ?? "Knowledge Entry";
      const description = (e["description"] as string) ?? "";
      const body = (e["body"] as string) ?? "";
      const images = Array.isArray(e["images"]) ? (e["images"] as Array<Record<string, unknown>>) : [];
      const imageUrl = (images[0]?.["url"] as string | undefined) ?? null;
      const snippet = (description || body).replace(/\s+/g, " ").trim().slice(0, 240);
      contextText += `[Knowledge Entry: ${title}]\n${description ? description + "\n" : ""}${body}\n\n`;
      citations.push({
        // No video to jump to — videoId is empty; entryId identifies the source.
        videoId: "",
        videoTitle: title,
        startTime: 0,
        endTime: 0,
        text: snippet,
        thumbnailUrl: imageUrl,
        sourceType: "knowledge",
        entryId: e["id"] as string,
      });
    }

    const usedInternalKnowledge = citations.length > 0;

    const systemPrompt = `You are Jack — an AI Trade Intelligence Engine for skilled trades workers in Canada. You help apprentices, journeypersons, and instructors understand trade knowledge, prepare for Red Seal certification, and find relevant training content.

CRITICAL RULE: Always search and prioritize the internal knowledge library before using any external knowledge. When internal content is available, ground your answer in it and cite it.

${usedInternalKnowledge ? `Relevant content from the internal knowledge library (training videos and written knowledge entries):\n\n${contextText}\nUse the above content to answer the question. Reference specific moments from videos where applicable, and draw on the written knowledge entries too.` : "No internal library content matched this query. Answer from general trades knowledge, but note that no specific internal content is available on this topic."}`;

    const { data: history } = await supabase
      .from("chat_messages")
      .select("role, content")
      .eq("session_id", session)
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
      { session_id: session, role: "user", content: message, citations: [] },
      { session_id: session, role: "assistant", content: answer, citations },
    ]);

    return res.json({ answer, citations, usedInternalKnowledge });
  } catch (err) {
    req.log.error({ err }, "askJack error");
    return res.status(500).json({ error: "Jack encountered an error" });
  }
});

router.get("/chat/history", async (req, res) => {
  try {
    // Session is bound to the HttpOnly cookie, not a query parameter.
    // If no session cookie exists, there is no conversation to return.
    const session = req.cookies?.[SESSION_COOKIE];
    if (typeof session !== "string" || session.length === 0) return res.json([]);

    const { data, error } = await supabase
      .from("chat_messages")
      .select("*")
      .eq("session_id", session)
      .order("created_at", { ascending: true })
      .limit(50);

    if (error) throw error;
    return res.json(
      (data ?? []).map((m: Record<string, unknown>) => ({
        id: m["id"],
        // sessionId is intentionally omitted — it is the caller's cookie value
        // and there is no reason to echo it back into the response body.
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

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default router;
