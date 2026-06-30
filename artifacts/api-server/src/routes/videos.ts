import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { openai, createEmbedding, MODELS } from "../lib/openai.js";
import {
  ListVideosQueryParams,
  CreateVideoBody,
  UpdateVideoBody,
  GetVideoParams,
  UpdateVideoParams,
  DeleteVideoParams,
  TranscribeVideoParams,
  AnalyzeVideoParams,
  FetchRelatedVideosParams,
  GetUploadUrlParams,
  GetUploadUrlBody,
} from "@workspace/api-zod";

const router = Router();

router.get("/videos", async (req, res) => {
  try {
    const query = ListVideosQueryParams.safeParse(req.query);
    const limit = query.success ? (query.data.limit ?? 20) : 20;
    const offset = query.success ? (query.data.offset ?? 0) : 0;
    const trade = query.success ? query.data.trade : undefined;
    const status = query.success ? query.data.status : undefined;

    let dbQuery = supabase
      .from("videos")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (trade) dbQuery = dbQuery.eq("trade", trade);
    if (status) dbQuery = dbQuery.eq("status", status);

    const { data, error, count } = await dbQuery;
    if (error) throw error;

    return res.json({ videos: data ?? [], total: count ?? 0 });
  } catch (err) {
    req.log.error({ err }, "listVideos error");
    return res.status(500).json({ error: "Failed to list videos" });
  }
});

router.post("/videos", async (req, res) => {
  try {
    const parsed = CreateVideoBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

    const { title, description, trade, tags } = parsed.data;
    const { data, error } = await supabase
      .from("videos")
      .insert({
        title,
        description: description ?? null,
        trade: trade ?? null,
        tags: tags ?? [],
        status: "pending",
        competency_codes: [],
      })
      .select()
      .single();

    if (error) throw error;
    return res.status(201).json(data);
  } catch (err) {
    req.log.error({ err }, "createVideo error");
    return res.status(500).json({ error: "Failed to create video" });
  }
});

router.get("/videos/stats", async (req, res) => {
  try {
    const { data: videos, error } = await supabase
      .from("videos")
      .select("status, trade, duration");
    if (error) throw error;

    const byStatus: Record<string, number> = {};
    const byTrade: Record<string, number> = {};
    let totalDuration = 0;

    for (const v of videos ?? []) {
      byStatus[v.status] = (byStatus[v.status] ?? 0) + 1;
      if (v.trade) byTrade[v.trade] = (byTrade[v.trade] ?? 0) + 1;
      if (v.duration) totalDuration += v.duration;
    }

    return res.json({ total: videos?.length ?? 0, byStatus, byTrade, totalDuration });
  } catch (err) {
    req.log.error({ err }, "getVideoStats error");
    return res.status(500).json({ error: "Failed to get stats" });
  }
});

router.get("/videos/recent", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("videos")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(6);
    if (error) throw error;
    return res.json(data ?? []);
  } catch (err) {
    req.log.error({ err }, "getRecentVideos error");
    return res.status(500).json({ error: "Failed to get recent videos" });
  }
});

router.get("/videos/:id", async (req, res) => {
  try {
    const parsed = GetVideoParams.safeParse(req.params);
    if (!parsed.success) return res.status(400).json({ error: "Invalid id" });

    const { data, error } = await supabase
      .from("videos")
      .select("*, transcript_segments(*)")
      .eq("id", parsed.data.id)
      .single();

    if (error || !data) return res.status(404).json({ error: "Video not found" });

    const segments = (data.transcript_segments ?? []).map((s: Record<string, unknown>) => ({
      id: s["id"],
      startTime: s["start_time"],
      endTime: s["end_time"],
      text: s["text"],
      confidence: s["confidence"] ?? null,
    }));

    return res.json({
      id: data.id,
      title: data.title,
      description: data.description ?? null,
      trade: data.trade ?? null,
      thumbnailUrl: data.thumbnail_url ?? null,
      videoUrl: data.video_url ?? null,
      duration: data.duration ?? null,
      status: data.status,
      competencyCodes: data.competency_codes ?? [],
      tags: data.tags ?? [],
      transcript: data.transcript ?? null,
      analysis: data.analysis ?? null,
      keyPoints: data.key_points ?? [],
      segments,
      createdAt: data.created_at,
      updatedAt: data.updated_at ?? null,
    });
  } catch (err) {
    req.log.error({ err }, "getVideo error");
    return res.status(500).json({ error: "Failed to get video" });
  }
});

router.patch("/videos/:id", async (req, res) => {
  try {
    const paramsParsed = UpdateVideoParams.safeParse(req.params);
    if (!paramsParsed.success) return res.status(400).json({ error: "Invalid id" });

    const bodyParsed = UpdateVideoBody.safeParse(req.body);
    if (!bodyParsed.success) return res.status(400).json({ error: bodyParsed.error.message });

    const { title, description, trade, tags, status } = bodyParsed.data;
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (title !== undefined) updates["title"] = title;
    if (description !== undefined) updates["description"] = description;
    if (trade !== undefined) updates["trade"] = trade;
    if (tags !== undefined) updates["tags"] = tags;
    if (status !== undefined) updates["status"] = status;

    const { data, error } = await supabase
      .from("videos")
      .update(updates)
      .eq("id", paramsParsed.data.id)
      .select()
      .single();

    if (error) throw error;
    return res.json(data);
  } catch (err) {
    req.log.error({ err }, "updateVideo error");
    return res.status(500).json({ error: "Failed to update video" });
  }
});

router.delete("/videos/:id", async (req, res) => {
  try {
    const parsed = DeleteVideoParams.safeParse(req.params);
    if (!parsed.success) return res.status(400).json({ error: "Invalid id" });

    const { error } = await supabase.from("videos").delete().eq("id", parsed.data.id);
    if (error) throw error;
    return res.status(204).send();
  } catch (err) {
    req.log.error({ err }, "deleteVideo error");
    return res.status(500).json({ error: "Failed to delete video" });
  }
});

router.post("/videos/:id/transcribe", async (req, res) => {
  try {
    const parsed = TranscribeVideoParams.safeParse(req.params);
    if (!parsed.success) return res.status(400).json({ error: "Invalid id" });
    const videoId = parsed.data.id;

    // Atomically acquire the transcription slot. This UPDATE only matches a row
    // with no transcript that isn't already transcribing, so concurrent
    // requests can never launch duplicate Whisper jobs (Postgres row-locks the
    // UPDATE and re-checks the WHERE clause for the loser).
    const { data: acquired } = await supabase
      .from("videos")
      .update({ status: "transcribing" })
      .eq("id", videoId)
      .is("transcript", null)
      .neq("status", "transcribing")
      .select("id")
      .maybeSingle();

    if (!acquired) {
      const { data: existing } = await supabase
        .from("videos")
        .select("status, transcript")
        .eq("id", videoId)
        .maybeSingle();

      if (!existing) return res.status(404).json({ error: "Video not found" });
      if (existing.transcript) {
        return res.status(200).json({
          jobId: `cached-${videoId}`,
          status: "ready",
          videoId,
          message: "Transcript already cached — skipped re-transcription",
        });
      }
      return res.status(202).json({
        jobId: `transcribe-${videoId}`,
        status: "processing",
        videoId,
        message: "Transcription already in progress",
      });
    }

    const jobId = `transcribe-${videoId}-${Date.now()}`;

    setImmediate(async () => {
      try {
        const { data: video } = await supabase
          .from("videos")
          .select("video_url, title")
          .eq("id", videoId)
          .single();

        if (!video?.video_url) {
          await supabase.from("videos").update({ status: "error" }).eq("id", videoId);
          return;
        }

        const response = await fetch(video.video_url);
        const buffer = await response.arrayBuffer();
        const file = new File([buffer], "audio.mp4", { type: "audio/mp4" });

        const transcription = await openai.audio.transcriptions.create({
          file,
          model: MODELS.transcription,
          response_format: "verbose_json",
          timestamp_granularities: ["segment"],
        });

        const segments = (transcription.segments ?? []).map((s) => ({
          video_id: videoId,
          start_time: s.start,
          end_time: s.end,
          text: s.text.trim(),
          confidence: null,
        }));

        if (segments.length > 0) {
          await supabase.from("transcript_segments").delete().eq("video_id", videoId);
          await supabase.from("transcript_segments").insert(segments);
        }

        const fullTranscript = transcription.text;

        const embeddingVec = await createEmbedding(fullTranscript.slice(0, 8000), {
          cache: false,
        });
        const embedding = embeddingVec.length > 0 ? embeddingVec : null;

        await supabase
          .from("videos")
          .update({
            status: "ready",
            transcript: fullTranscript,
            embedding: embedding ? JSON.stringify(embedding) : null,
          })
          .eq("id", videoId);
      } catch (bgErr) {
        console.error("Transcription failed:", bgErr);
        await supabase.from("videos").update({ status: "error" }).eq("id", videoId);
      }
    });

    return res.status(202).json({ jobId, status: "processing", videoId, message: "Transcription started" });
  } catch (err) {
    req.log.error({ err }, "transcribeVideo error");
    return res.status(500).json({ error: "Failed to start transcription" });
  }
});

router.post("/videos/:id/analyze", async (req, res) => {
  try {
    const parsed = AnalyzeVideoParams.safeParse(req.params);
    if (!parsed.success) return res.status(400).json({ error: "Invalid id" });
    const videoId = parsed.data.id;

    // Atomically acquire the analysis slot. This UPDATE only matches a row that
    // has a transcript, no cached analysis, and isn't already analyzing, so
    // concurrent requests can never launch duplicate GPT analysis jobs.
    const { data: acquired } = await supabase
      .from("videos")
      .update({ status: "analyzing" })
      .eq("id", videoId)
      .not("transcript", "is", null)
      .is("analysis", null)
      .neq("status", "analyzing")
      .select("id")
      .maybeSingle();

    if (!acquired) {
      const { data: existing } = await supabase
        .from("videos")
        .select("status, analysis, transcript")
        .eq("id", videoId)
        .maybeSingle();

      if (!existing) return res.status(404).json({ error: "Video not found" });
      if (existing.analysis) {
        return res.status(200).json({
          jobId: `cached-${videoId}`,
          status: "ready",
          videoId,
          message: "Analysis already cached — skipped re-analysis",
        });
      }
      if (!existing.transcript) {
        return res.status(400).json({ error: "Video must be transcribed before analysis" });
      }
      return res.status(202).json({
        jobId: `analyze-${videoId}`,
        status: "processing",
        videoId,
        message: "Analysis already in progress",
      });
    }

    const jobId = `analyze-${videoId}-${Date.now()}`;

    setImmediate(async () => {
      try {
        const { data: video } = await supabase
          .from("videos")
          .select("transcript, title, trade")
          .eq("id", videoId)
          .single();

        if (!video?.transcript) {
          await supabase.from("videos").update({ status: "error" }).eq("id", videoId);
          return;
        }

        const { data: competencies } = await supabase.from("competencies").select("code, name, trade");

        const competencyContext = (competencies ?? [])
          .map((c: Record<string, string>) => `${c["code"]}: ${c["name"]} (${c["trade"]})`)
          .join("\n");

        const completion = await openai.chat.completions.create({
          model: MODELS.analysis,
          messages: [
            {
              role: "system",
              content: `You are Jack — an AI assistant specialized in skilled trades training and Red Seal certification. Analyze training video transcripts and map them to Red Seal competencies.\n\nAvailable Red Seal competencies:\n${competencyContext}`,
            },
            {
              role: "user",
              content: `Analyze this training video transcript for "${video.title}" (trade: ${video.trade ?? "general"}).\n\nTranscript:\n${video.transcript.slice(0, 6000)}\n\nRespond with a JSON object:\n{\n  "analysis": "2-3 paragraph summary of what this video teaches",\n  "keyPoints": ["point 1", "point 2", "point 3", "point 4", "point 5"],\n  "competencyCodes": ["CODE1", "CODE2"]\n}`,
            },
          ],
          response_format: { type: "json_object" },
        });

        const result = JSON.parse(completion.choices[0]?.message?.content ?? "{}") as {
          analysis?: string;
          keyPoints?: string[];
          competencyCodes?: string[];
        };

        await supabase
          .from("videos")
          .update({
            status: "ready",
            analysis: result.analysis ?? null,
            key_points: result.keyPoints ?? [],
            competency_codes: result.competencyCodes ?? [],
          })
          .eq("id", videoId);
      } catch (bgErr) {
        console.error("Analysis failed:", bgErr);
        await supabase.from("videos").update({ status: "error" }).eq("id", videoId);
      }
    });

    return res.status(202).json({ jobId, status: "processing", videoId, message: "Analysis started" });
  } catch (err) {
    req.log.error({ err }, "analyzeVideo error");
    return res.status(500).json({ error: "Failed to start analysis" });
  }
});

router.get("/videos/:id/related", async (req, res) => {
  try {
    const parsed = FetchRelatedVideosParams.safeParse(req.params);
    if (!parsed.success) return res.status(400).json({ error: "Invalid id" });

    const { data: video } = await supabase
      .from("videos")
      .select("embedding, trade, competency_codes")
      .eq("id", parsed.data.id)
      .single();

    if (!video?.embedding) {
      const { data: fallback } = await supabase
        .from("videos")
        .select("*")
        .neq("id", parsed.data.id)
        .eq("status", "ready")
        .limit(4);
      return res.json(fallback ?? []);
    }

    const embedding: number[] = JSON.parse(video.embedding as string);
    const { data: similar, error } = await supabase.rpc("match_videos", {
      query_embedding: embedding,
      match_threshold: 0.7,
      match_count: 5,
      exclude_id: parsed.data.id,
    });

    if (error || !similar?.length) {
      const { data: fallback } = await supabase
        .from("videos")
        .select("*")
        .neq("id", parsed.data.id)
        .eq("status", "ready")
        .limit(4);
      return res.json(fallback ?? []);
    }

    return res.json(similar.slice(0, 4));
  } catch (err) {
    req.log.error({ err }, "fetchRelatedVideos error");
    return res.status(500).json({ error: "Failed to fetch related videos" });
  }
});

router.post("/videos/:id/upload-url", async (req, res) => {
  try {
    const paramsParsed = GetUploadUrlParams.safeParse(req.params);
    if (!paramsParsed.success) return res.status(400).json({ error: "Invalid id" });

    const bodyParsed = GetUploadUrlBody.safeParse(req.body);
    if (!bodyParsed.success) return res.status(400).json({ error: bodyParsed.error.message });

    const { filename } = bodyParsed.data;
    const path = `videos/${paramsParsed.data.id}/${filename}`;

    const { data, error } = await supabase.storage
      .from("jack-videos")
      .createSignedUploadUrl(path);

    if (error) throw error;

    await supabase
      .from("videos")
      .update({
        video_url: `${process.env["SUPABASE_URL"]}/storage/v1/object/public/jack-videos/${path}`,
      })
      .eq("id", paramsParsed.data.id);

    return res.json({ uploadUrl: data.signedUrl, path, token: (data as Record<string, unknown>)["token"] ?? null });
  } catch (err) {
    req.log.error({ err }, "getUploadUrl error");
    return res.status(500).json({ error: "Failed to get upload URL" });
  }
});

export default router;
