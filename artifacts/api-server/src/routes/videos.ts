import { Router } from "express";
import multer from "multer";
import { supabase } from "../lib/supabase.js";
import { openai, createEmbedding, createEmbeddings, MODELS } from "../lib/openai.js";
import { logger } from "../lib/logger.js";
import { transcribeFromUrl } from "../lib/transcription.js";
import { syncVideoGraph, removeVideoGraph } from "../lib/memory-graph.js";
import { runDistillation } from "../lib/distillation.js";
import { aiPipelineLimiter } from "../lib/rate-limit.js";
import { requireAdminSession } from "../lib/admin-auth.js";
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

/**
 * Strip HTML tags from a string so that prompt-injected markup in LLM output
 * is never stored in the database, regardless of how the value is later rendered.
 * This is a defense-in-depth measure: the client already uses safe React text
 * interpolation, but sanitizing at write-time prevents stored-XSS if any future
 * code path ever renders the value as HTML.
 */
function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, "").trim();
}

/**
 * Best-effort mirror of a video into the persisted knowledge graph. The graph is
 * a derived view, so a sync failure must never fail (or roll back) the underlying
 * video operation — we log and move on; GET /graph self-heals from source tables.
 */
async function syncGraphSafe(videoId: string): Promise<void> {
  try {
    await syncVideoGraph(videoId);
  } catch (err) {
    logger.error({ err, videoId }, "knowledge graph sync failed");
  }
}

async function removeGraphSafe(videoId: string): Promise<void> {
  try {
    await removeVideoGraph(videoId);
  } catch (err) {
    logger.error({ err, videoId }, "knowledge graph node removal failed");
  }
}

/**
 * Best-effort atomic-knowledge distillation for a ready video. Like graph sync,
 * this is a value-add on a derived view: a distillation failure (or LLM/Supabase
 * hiccup) must never downgrade a successfully transcribed/analyzed video, so we
 * log and move on. Runs after the video node + competency edges are already
 * mirrored, so the video→knowledge provenance edges attach to an existing node.
 */
export async function distillGraphSafe(videoId: string): Promise<void> {
  try {
    await runDistillation(videoId);
  } catch (err) {
    logger.error({ err, videoId }, "atomic knowledge distillation failed");
  }
}

/**
 * Run GPT analysis for a transcribed video: summarize it, extract key points,
 * and map it to Red Seal competency codes. Shared by the POST /analyze route
 * and the transcription pipeline (which chains analysis automatically).
 *
 * Analysis is a value-add on top of an already-usable transcript, so a failure
 * here never downgrades a successfully transcribed video to "error".
 */
export async function runAnalysis(videoId: string): Promise<void> {
  try {
    const { data: video } = await supabase
      .from("videos")
      .select("transcript, title, trade")
      .eq("id", videoId)
      .single();

    if (!video?.transcript) {
      await supabase.from("videos").update({ status: "error" }).eq("id", videoId);
      await syncGraphSafe(videoId);
      return;
    }

    const { data: competencies } = await supabase
      .from("competencies")
      .select("code, name, trade");

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
      analysis?: unknown;
      keyPoints?: unknown;
      competencyCodes?: unknown;
    };

    // Normalize GPT output before writing — a malformed keyPoints/competencyCodes
    // value would otherwise fail the text[] column write and (since Supabase
    // returns the error instead of throwing) silently leave the row "analyzing".
    const analysisText =
      typeof result.analysis === "string" ? stripHtml(result.analysis) : null;
    const keyPoints = Array.isArray(result.keyPoints)
      ? result.keyPoints
          .filter((p): p is string => typeof p === "string")
          .map(stripHtml)
      : [];
    const competencyCodes = Array.isArray(result.competencyCodes)
      ? result.competencyCodes.filter((c): c is string => typeof c === "string")
      : [];

    const { error: readyErr } = await supabase
      .from("videos")
      .update({
        status: "ready",
        analysis: analysisText,
        key_points: keyPoints,
        competency_codes: competencyCodes,
      })
      .eq("id", videoId);
    // Surface a failed final write into the catch so the video still reaches a
    // terminal state instead of being stuck in "analyzing" forever.
    if (readyErr) throw readyErr;

    // Video reached "ready" with competency mappings — mirror it into the graph
    // so the new node and its competency edges appear on the next poll.
    await syncGraphSafe(videoId);
    // Then distill the transcript into reusable atomic knowledge nodes, attaching
    // this video's provenance edges to the node we just mirrored.
    await distillGraphSafe(videoId);
  } catch (bgErr) {
    logger.error({ err: bgErr, videoId }, "Analysis failed");
    // Keep a successfully-transcribed video usable even if analysis failed —
    // only the optional competency mapping/summary is missing. This is a checked
    // write so we can fall back to "error" if even this terminal update fails.
    const { error: fallbackErr } = await supabase
      .from("videos")
      .update({ status: "ready" })
      .eq("id", videoId)
      .not("transcript", "is", null);
    if (fallbackErr) {
      logger.error({ err: fallbackErr, videoId }, "Analysis fallback status write failed");
      await supabase.from("videos").update({ status: "error" }).eq("id", videoId);
    }
    // Still surface the (transcribed) video as a node even when analysis failed.
    await syncGraphSafe(videoId);
  }
}

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

const ALLOWED_VIDEO_TYPES = new Set([
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/quicktime",
  "video/x-msvideo",
  "video/x-matroska",
  "video/3gpp",
  "video/3gpp2",
]);

// ---------------------------------------------------------------------------
// Multer — memory storage for proxied video ingest. We stream the buffer
// directly to Supabase Storage so no temp file touches the server disk.
// 2 GB cap matches the UI label; Multer enforces it before the handler runs.
// ---------------------------------------------------------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, ALLOWED_VIDEO_TYPES.has(file.mimetype));
  },
});

/**
 * POST /videos/ingest — fully server-side upload flow.
 *
 * Accepts multipart/form-data with fields:
 *   file       — the video binary
 *   title      — required string
 *   description, trade, tags — optional
 *
 * The server creates the DB record, uploads to Supabase Storage using the
 * service-role key (never exposed to the browser), writes the public URL
 * back, and kicks off transcription.  No signed URL ever leaves the server.
 */
router.post(
  "/videos/ingest",
  requireAdminSession,
  aiPipelineLimiter,
  upload.single("file"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "A video file is required." });
      }

      const title = typeof req.body["title"] === "string" ? req.body["title"].trim() : "";
      if (!title) return res.status(400).json({ error: "title is required." });

      const description =
        typeof req.body["description"] === "string" ? req.body["description"] : undefined;
      const trade =
        typeof req.body["trade"] === "string" ? req.body["trade"] : undefined;

      // 1. Create the DB record.
      const { data: video, error: insertErr } = await supabase
        .from("videos")
        .insert({
          title,
          description: description ?? null,
          trade: trade ?? null,
          tags: [],
          status: "pending",
          competency_codes: [],
        })
        .select()
        .single();

      if (insertErr) throw insertErr;

      // 2. Upload bytes to Supabase Storage using the service-role key.
      //    No signed URL is issued — the server performs the upload directly.
      const filename = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
      const storagePath = `videos/${video.id}/${filename}`;

      const { error: uploadErr } = await supabase.storage
        .from("jack-videos")
        .upload(storagePath, req.file.buffer, {
          contentType: req.file.mimetype,
          upsert: false,
        });

      if (uploadErr) {
        // Roll back the DB row if storage fails.
        await supabase.from("videos").delete().eq("id", video.id);
        throw uploadErr;
      }

      // 3. Write the public URL back to the video row.
      const publicUrl = `${process.env["SUPABASE_URL"]}/storage/v1/object/public/jack-videos/${storagePath}`;
      await supabase.from("videos").update({ video_url: publicUrl }).eq("id", video.id);

      // 4. Sync graph node for the new video.
      await syncGraphSafe(video.id);

      // 5. Atomically acquire the transcription slot and kick it off.
      const { data: acquired } = await supabase
        .from("videos")
        .update({ status: "transcribing" })
        .eq("id", video.id)
        .is("transcript", null)
        .neq("status", "transcribing")
        .select("id")
        .maybeSingle();

      if (acquired) {
        setImmediate(async () => {
          try {
            const { text: fullTranscript, segments: rawSegments } =
              await transcribeFromUrl(publicUrl);

            const segments = rawSegments.map((s) => ({
              video_id: video.id,
              start_time: s.start,
              end_time: s.end,
              text: s.text,
              confidence: null as number | null,
              embedding: null as string | null,
            }));

            if (segments.length > 0) {
              const vectors = await createEmbeddings(segments.map((s) => s.text || " "));
              segments.forEach((seg, i) => {
                const vec = vectors[i];
                seg.embedding = vec && vec.length > 0 ? JSON.stringify(vec) : null;
              });
            }

            await supabase.from("transcript_segments").delete().eq("video_id", video.id);
            const BATCH = 100;
            for (let i = 0; i < segments.length; i += BATCH) {
              const { error: segErr } = await supabase
                .from("transcript_segments")
                .insert(segments.slice(i, i + BATCH));
              if (segErr) throw segErr;
            }

            const videoEmbedding = await createEmbedding(fullTranscript.slice(0, 8000));
            await supabase
              .from("videos")
              .update({
                transcript: fullTranscript,
                embedding: JSON.stringify(videoEmbedding),
              })
              .eq("id", video.id);

            await syncGraphSafe(video.id);
            void runAnalysis(video.id);
          } catch (bgErr) {
            logger.error({ err: bgErr, videoId: video.id }, "Ingest transcription failed");
            await supabase.from("videos").update({ status: "error" }).eq("id", video.id);
            await syncGraphSafe(video.id);
          }
        });
      }

      return res.status(201).json({ ...video, video_url: publicUrl });
    } catch (err) {
      req.log.error({ err }, "ingestVideo error");
      return res.status(500).json({ error: "Failed to ingest video" });
    }
  },
);

router.post("/videos", requireAdminSession, aiPipelineLimiter, async (req, res) => {
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

    // Surface the new (pending) video as a node right away.
    await syncGraphSafe(data.id);
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

router.patch("/videos/:id", requireAdminSession, async (req, res) => {
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

    // Reconcile the node (title/status/meta) and re-home it if the trade changed.
    await syncGraphSafe(paramsParsed.data.id);
    return res.json(data);
  } catch (err) {
    req.log.error({ err }, "updateVideo error");
    return res.status(500).json({ error: "Failed to update video" });
  }
});

router.delete("/videos/:id", requireAdminSession, aiPipelineLimiter, async (req, res) => {
  try {
    const parsed = DeleteVideoParams.safeParse(req.params);
    if (!parsed.success) return res.status(400).json({ error: "Invalid id" });

    const { error } = await supabase.from("videos").delete().eq("id", parsed.data.id);
    if (error) throw error;

    // Drop the video node; its edges cascade away with it.
    await removeGraphSafe(parsed.data.id);
    return res.status(204).send();
  } catch (err) {
    req.log.error({ err }, "deleteVideo error");
    return res.status(500).json({ error: "Failed to delete video" });
  }
});

router.post("/videos/:id/transcribe", requireAdminSession, aiPipelineLimiter, async (req, res) => {
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
          await syncGraphSafe(videoId);
          return;
        }

        // Extract compact speech audio and transcribe (auto-chunking large
        // videos under Whisper's 25 MB upload limit, with continuous timestamps).
        const { text: fullTranscript, segments: rawSegments } = await transcribeFromUrl(
          video.video_url,
        );

        const segments = rawSegments.map((s) => ({
          video_id: videoId,
          start_time: s.start,
          end_time: s.end,
          text: s.text,
          confidence: null as number | null,
          embedding: null as string | null,
        }));

        // Embed every segment so semantic search and Ask Jack RAG can match on
        // specific moments — this is what powers the timestamp citations. The
        // embeddings call is batched to keep cost and round-trips low.
        if (segments.length > 0) {
          const vectors = await createEmbeddings(segments.map((s) => s.text || " "));
          segments.forEach((seg, i) => {
            const vec = vectors[i];
            seg.embedding = vec && vec.length > 0 ? JSON.stringify(vec) : null;
          });
        }

        // Clear any prior segments first so a retry that yields fewer (or zero)
        // segments never leaves stale rows behind.
        await supabase.from("transcript_segments").delete().eq("video_id", videoId);
        if (segments.length > 0) {
          // Insert in modest batches — each row now carries a 1536-dim embedding,
          // so keep request bodies well within Supabase's limits.
          const BATCH = 100;
          for (let i = 0; i < segments.length; i += BATCH) {
            const { error: insertErr } = await supabase
              .from("transcript_segments")
              .insert(segments.slice(i, i + BATCH));
            if (insertErr) throw insertErr;
          }
        }

        const trimmed = fullTranscript.trim();
        const embeddingVec =
          trimmed.length > 0
            ? await createEmbedding(trimmed.slice(0, 8000), { cache: false })
            : [];
        const embedding = embeddingVec.length > 0 ? embeddingVec : null;

        // Persist the transcript + whole-video embedding. Status stays
        // "transcribing" here so the chained analysis below carries the video
        // forward in a single pass: transcribing -> analyzing -> ready.
        await supabase
          .from("videos")
          .update({
            transcript: fullTranscript,
            embedding: embedding ? JSON.stringify(embedding) : null,
          })
          .eq("id", videoId);

        // Auto-chain analysis so one upload yields a transcript AND competency
        // tags + summary with no extra clicks (the 5-minute demo flow). Reuse
        // the same idempotent slot guard the /analyze route uses.
        const { data: analyzeSlot } = await supabase
          .from("videos")
          .update({ status: "analyzing" })
          .eq("id", videoId)
          .not("transcript", "is", null)
          .is("analysis", null)
          .neq("status", "analyzing")
          .select("id")
          .maybeSingle();

        if (analyzeSlot) {
          await runAnalysis(videoId);
        } else {
          // Already analyzed (or being analyzed elsewhere) — just make sure the
          // video reaches a ready state without overriding an in-flight analyze.
          await supabase
            .from("videos")
            .update({ status: "ready" })
            .eq("id", videoId)
            .neq("status", "analyzing");
        }

        // Mirror the finished video into the knowledge graph whichever branch ran.
        await syncGraphSafe(videoId);
      } catch (bgErr) {
        logger.error({ err: bgErr, videoId }, "Transcription failed");
        await supabase.from("videos").update({ status: "error" }).eq("id", videoId);
        await syncGraphSafe(videoId);
      }
    });

    return res.status(202).json({ jobId, status: "processing", videoId, message: "Transcription started" });
  } catch (err) {
    req.log.error({ err }, "transcribeVideo error");
    return res.status(500).json({ error: "Failed to start transcription" });
  }
});

router.post("/videos/:id/analyze", requireAdminSession, aiPipelineLimiter, async (req, res) => {
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

    setImmediate(() => {
      void runAnalysis(videoId);
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

router.post("/videos/:id/upload-url", requireAdminSession, aiPipelineLimiter, async (req, res) => {
  try {
    const paramsParsed = GetUploadUrlParams.safeParse(req.params);
    if (!paramsParsed.success) return res.status(400).json({ error: "Invalid id" });

    const bodyParsed = GetUploadUrlBody.safeParse(req.body);
    if (!bodyParsed.success) return res.status(400).json({ error: bodyParsed.error.message });

    const { filename, contentType } = bodyParsed.data;

    if (!ALLOWED_VIDEO_TYPES.has(contentType)) {
      return res.status(400).json({ error: "Unsupported file type. Only video files are accepted." });
    }

    const videoId = paramsParsed.data.id;

    // Verify the video record actually exists before issuing a storage token.
    // Without this check, a caller could mint a valid upload URL for a
    // fabricated ID and populate the bucket with orphaned objects.
    const { data: existing, error: lookupErr } = await supabase
      .from("videos")
      .select("id")
      .eq("id", videoId)
      .maybeSingle();

    if (lookupErr) throw lookupErr;
    if (!existing) return res.status(404).json({ error: "Video not found" });

    const path = `videos/${videoId}/${filename}`;

    const { data, error } = await supabase.storage
      .from("jack-videos")
      .createSignedUploadUrl(path);

    if (error) throw error;

    await supabase
      .from("videos")
      .update({
        video_url: `${process.env["SUPABASE_URL"]}/storage/v1/object/public/jack-videos/${path}`,
      })
      .eq("id", videoId);

    return res.json({ uploadUrl: data.signedUrl, path, token: (data as Record<string, unknown>)["token"] ?? null });
  } catch (err) {
    req.log.error({ err }, "getUploadUrl error");
    return res.status(500).json({ error: "Failed to get upload URL" });
  }
});

export default router;
