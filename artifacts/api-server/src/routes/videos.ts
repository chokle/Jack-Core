import { Router } from "express";
import multer from "multer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { supabase } from "../lib/supabase.js";
import {
  claimStage,
  enqueuePipeline,
  syncGraphSafe,
  removeGraphSafe,
  CLAIMABLE_STATUSES,
} from "../lib/jobs.js";
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

// Re-exported for callers/tests that historically imported these from the
// routes module. The implementations now live in the durable job system.
export { distillGraphSafe, runAnalysis } from "../lib/jobs.js";

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
// Multer — DISK storage for proxied video ingest. The file spools to a tmp
// dir instead of the Node heap (memoryStorage buffered up to 2 GB in RAM per
// in-flight upload — two concurrent large uploads could OOM the process).
// The handler streams the temp file to Supabase Storage and removes it in a
// finally block on both success and failure.
// 2 GB cap matches the UI label; Multer enforces it before the handler runs.
// ---------------------------------------------------------------------------
const UPLOAD_TMP_DIR = path.join(os.tmpdir(), "jack-uploads");
fs.mkdirSync(UPLOAD_TMP_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_TMP_DIR,
    filename: (_req, _file, cb) => {
      cb(null, `ingest-${Date.now()}-${crypto.randomUUID()}`);
    },
  }),
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
    const tempPath = req.file?.path;
    try {
      if (!req.file || !tempPath) {
        return res.status(400).json({ error: "A video file is required." });
      }

      const title = typeof req.body["title"] === "string" ? req.body["title"].trim() : "";
      if (!title) return res.status(400).json({ error: "title is required." });

      const description =
        typeof req.body["description"] === "string" ? req.body["description"] : undefined;
      const trade =
        typeof req.body["trade"] === "string" ? req.body["trade"] : undefined;

      // 1. Create the DB record. The server itself performs the upload, so the
      //    row starts in "uploading" (heartbeat marks when it started).
      const { data: video, error: insertErr } = await supabase
        .from("videos")
        .insert({
          title,
          description: description ?? null,
          trade: trade ?? null,
          tags: [],
          status: "uploading",
          heartbeat_at: new Date().toISOString(),
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
        .upload(storagePath, fs.createReadStream(tempPath), {
          contentType: req.file.mimetype,
          upsert: false,
        });

      if (uploadErr) {
        // Roll back the DB row if storage fails.
        await supabase.from("videos").delete().eq("id", video.id);
        throw uploadErr;
      }

      // 3. Media is confirmed in storage — write the public URL back and flip
      //    the row to "uploaded" (durable checkpoint the recovery sweep can
      //    resume from if we crash before the pipeline claim below).
      const publicUrl = `${process.env["SUPABASE_URL"]}/storage/v1/object/public/jack-videos/${storagePath}`;
      await supabase
        .from("videos")
        .update({ video_url: publicUrl, status: "uploaded" })
        .eq("id", video.id);

      // 4. Sync graph node for the new video.
      await syncGraphSafe(video.id);

      // 5. Atomically claim the transcription slot and kick off the pipeline.
      const acquired = await claimStage(video.id, "transcribing", {
        from: ["uploaded"],
        requireNoTranscript: true,
      });
      if (acquired) enqueuePipeline(video.id, "transcribing");

      return res.status(201).json({
        ...video,
        video_url: publicUrl,
        status: acquired ? "transcribing" : "uploaded",
      });
    } catch (err) {
      req.log.error({ err }, "ingestVideo error");
      return res.status(500).json({ error: "Failed to ingest video" });
    } finally {
      // Always remove the spooled temp file — success or failure.
      if (tempPath) {
        fs.promises.unlink(tempPath).catch((err) => {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            req.log.warn({ err, tempPath }, "failed to remove ingest temp file");
          }
        });
      }
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
        status: "queued",
        competency_codes: [],
      })
      .select()
      .single();

    if (error) throw error;

    // Surface the new (queued) video as a node right away.
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
      attempts: data.attempts ?? null,
      lastError: data.last_error ?? null,
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

    // Atomically claim the transcription slot. The conditional UPDATE only
    // matches a row with no transcript in a claimable (non-in-flight) status,
    // so concurrent requests can never launch duplicate Whisper jobs (Postgres
    // row-locks the UPDATE and re-checks the WHERE clause for the loser).
    // "failed"/"retrying" are claimable on purpose — this is the manual retry.
    const acquired = await claimStage(videoId, "transcribing", {
      from: CLAIMABLE_STATUSES,
      requireNoTranscript: true,
    });

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
          status: "completed",
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

    // Full durable pipeline: transcribing → analyzing → indexing → completed.
    enqueuePipeline(videoId, "transcribing");

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

    // Atomically claim the analysis slot. The conditional UPDATE only matches
    // a row that has a transcript, no cached analysis, and is not already
    // in-flight, so concurrent requests can never launch duplicate GPT jobs.
    // "completed" is claimable here: a video that finished without analysis
    // (non-fatal analysis exhaustion) can be re-analyzed on demand.
    const acquired = await claimStage(videoId, "analyzing", {
      from: [...CLAIMABLE_STATUSES, "completed"],
      requireTranscript: true,
      requireNoAnalysis: true,
    });

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
          status: "completed",
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

    // Runs analyzing → indexing → completed through the durable pipeline.
    enqueuePipeline(videoId, "analyzing");

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
        .eq("status", "completed")
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
        .eq("status", "completed")
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

    // Mark the client-driven upload as started (only from a not-yet-processing
    // status — never clobber an in-flight or completed row). The recovery
    // sweep fails "uploading" rows that outlive the TTL, since the server
    // cannot resume a browser-owned upload.
    await supabase
      .from("videos")
      .update({ status: "uploading", heartbeat_at: new Date().toISOString() })
      .eq("id", videoId)
      .in("status", ["queued", "failed"]);

    return res.json({ uploadUrl: data.signedUrl, path, token: (data as Record<string, unknown>)["token"] ?? null });
  } catch (err) {
    req.log.error({ err }, "getUploadUrl error");
    return res.status(500).json({ error: "Failed to get upload URL" });
  }
});

export default router;
