import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { openai, createEmbedding, MODELS } from "../lib/openai.js";
import { AskJackBody } from "@workspace/api-zod";
import { randomUUID } from "crypto";

const router = Router();

router.post("/chat", async (req, res) => {
  try {
    const parsed = AskJackBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

    const { message, sessionId } = parsed.data;
    const session = sessionId ?? randomUUID();

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

    const citations: Array<{
      videoId: string;
      videoTitle: string;
      startTime: number;
      endTime: number;
      text: string;
      thumbnailUrl: string | null;
    }> = [];

    let contextText = "";
    const usedInternalKnowledge = (segments ?? []).length > 0;

    if (usedInternalKnowledge) {
      for (const seg of segments as Array<Record<string, unknown>>) {
        contextText += `[${seg["video_title"] ?? "Video"} @ ${formatTime(seg["start_time"] as number)}]\n${seg["text"]}\n\n`;
        citations.push({
          videoId: seg["video_id"] as string,
          videoTitle: (seg["video_title"] as string) ?? "Unknown",
          startTime: seg["start_time"] as number,
          endTime: seg["end_time"] as number,
          text: seg["text"] as string,
          thumbnailUrl: (seg["thumbnail_url"] as string | null) ?? null,
        });
      }
    }

    const systemPrompt = `You are Jack — an AI Trade Intelligence Engine for skilled trades workers in Canada. You help apprentices, journeypersons, and instructors understand trade knowledge, prepare for Red Seal certification, and find relevant training content.

CRITICAL RULE: Always search and prioritize the internal knowledge library before using any external knowledge. When internal content is available, ground your answer in it and cite it.

${usedInternalKnowledge ? `Relevant content from the internal knowledge library:\n\n${contextText}\nUse the above content to answer the question. Reference specific moments from videos where applicable.` : "No internal library content matched this query. Answer from general trades knowledge, but note that no specific training videos are available on this topic."}`;

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

    const completion = await openai.chat.completions.create({
      model: MODELS.chat,
      messages,
      max_tokens: 1024,
    });

    const answer = completion.choices[0]?.message?.content ?? "I wasn't able to generate a response.";

    await supabase.from("chat_messages").insert([
      { session_id: session, role: "user", content: message, citations: [] },
      { session_id: session, role: "assistant", content: answer, citations },
    ]);

    return res.json({ answer, citations, sessionId: session, usedInternalKnowledge });
  } catch (err) {
    req.log.error({ err }, "askJack error");
    return res.status(500).json({ error: "Jack encountered an error" });
  }
});

router.get("/chat/history", async (req, res) => {
  try {
    // Chat history is private to a single session. Require the caller to name a
    // session and scope the query to it — without this filter the endpoint
    // returned every user's recent messages, leaking conversations across
    // sessions. No session id => no messages (never a global dump).
    const rawSession = req.query["sessionId"];
    const sessionId = typeof rawSession === "string" ? rawSession.trim() : "";
    if (!sessionId) return res.json([]);

    const { data, error } = await supabase
      .from("chat_messages")
      .select("*")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true })
      .limit(50);

    if (error) throw error;
    return res.json(
      (data ?? []).map((m: Record<string, unknown>) => ({
        id: m["id"],
        sessionId: m["session_id"],
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
