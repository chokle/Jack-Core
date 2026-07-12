import { Router, type Request } from "express";
import multer from "multer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { supabase } from "../lib/supabase.js";
import {
  claimStage,
  enqueuePipeline,
  syncGraphSafe,
  removeGraphSafe,
  CLAIMABLE_STATUSES,
} from "../lib/jobs.js";
import { aiPipelineLimiter, ingestLimiter } from "../lib/rate-limit.js";
import { resolveIdentity } from "../lib/admin-auth.js";
import { requireAdmin } from "../lib/admin-auth.js";
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
export { runAnalysis } from "../lib/jobs.js";

/**
 * Map a raw snake_case `videos` row to the camelCase `Video` shape the OpenAPI
 * contract (and the React client) expect. The list and recent endpoints both
 * `select("*")`, so without this the client reads `undefined` for thumbnailUrl,
 * videoUrl, duration, competencyCodes, etc. (the detail endpoint already maps).
 */
function toVideoResponse(v: Record<string, unknown>) {
  return {
    id: v["id"],
    title: v["title"],
    description: v["description"] ?? null,
    trade: v["trade"] ?? null,
    thumbnailUrl: v["thumbnail_url"] ?? null,
    videoUrl: v["video_url"] ?? null,
    duration: v["duration"] ?? null,
    status: v["status"],
    competencyCodes: v["competency_codes"] ?? [],
    tags: v["tags"] ?? [],
    attempts: v["attempts"] ?? null,
    lastError: v["last_error"] ?? null,
    uploaderUserId: v["uploader_user_id"] ?? null,
    uploaderEmail: v["uploader_email"] ?? null,
    uploaderName: v["uploader_name"] ?? null,
    createdAt: v["created_at"],
    updatedAt: v["updated_at"] ?? null,
  };
}

function normalizeDuplicateValue(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase().replace(/\s+/g, " ") : "";
}

async function getDuplicateEligibility(video: Record<string, unknown>, userId?: string | null) {
  const uploaderUserId = typeof video["uploader_user_id"] === "string" ? video["uploader_user_id"] : "";
  const title = normalizeDuplicateValue(video["title"]);
  const trade = normalizeDuplicateValue(video["trade"]);

  if (!userId || !uploaderUserId || userId !== uploaderUserId || !title) {
    return { duplicateCount: 0, canDeleteDuplicate: false };
  }

  const { data, error } = await supabase
    .from("videos")
    .select("id, title, trade")
    .eq("uploader_user_id", uploaderUserId);

  if (error) throw error;

  const duplicateCount = (data ?? []).filter((row: Record<string, unknown>) => (
    normalizeDuplicateValue(row["title"]) === title &&
    normalizeDuplicateValue(row["trade"]) === trade
  )).length;

  return { duplicateCount, canDeleteDuplicate: duplicateCount > 1 };
}

async function canProcessVideo(videoId: string, req: Request) {
  const identity = await resolveIdentity(req);
  const userId = identity?.userId ?? req.userId;
  if (!userId) return { ok: false as const, status: 401, error: "Unauthorized" };
  if (identity?.isAdmin) return { ok: true as const };

  const { data, error } = await supabase
    .from("videos")
    .select("uploader_user_id")
    .eq("id", videoId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return { ok: false as const, status: 404, error: "Video not found" };
  if (data["uploader_user_id"] !== userId) {
    return { ok: false as const, status: 403, error: "Only the uploader can process this video." };
  }
  return { ok: true as const };
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

    return res.json({ videos: (data ?? []).map(toVideoResponse), total: count ?? 0 });
  } catch (err) {
    req.log.error({ err }, "listVideos error");
    return res.status(500).json({ error: "Failed to list videos" });
  }
});

/**
 * Detects Supabase Storage's oversized-object rejection. The project-level
 * "Upload file size limit" (Storage → Settings) returns HTTP 413 with a message
 * like "The object exceeded the maximum allowed size", independent of our own
 * multer cap. Match on either the numeric status or the message so we stay
 * robust across storage-js error shapes.
 */
function isFileSizeLimitError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: unknown; statusCode?: unknown; message?: unknown };
  if (e.status === 413 || e.statusCode === 413 || e.statusCode === "413") return true;
  const message = typeof e.message === "string" ? e.message.toLowerCase() : "";
  return (
    message.includes("exceeded the maximum allowed size") ||
    message.includes("payload too large") ||
    message.includes("maximum allowed size")
  );
}

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

// Some browsers/OS combinations report a generic or slightly different
// Content-Type for a video part in a multipart upload (e.g. "application/
// octet-stream", or omit it entirely) even though the file extension makes
// the format unambiguous. If we stored that generic type in Supabase
// Storage, it would be served back as the object's Content-Type header and
// break `<video>` playback even for otherwise-supported MP4 files — some
// browsers (notably Safari) refuse to play a video whose Content-Type
// header doesn't match a supported video type. Falling back to an
// extension-based lookup keeps the stored/served type accurate.
const VIDEO_EXTENSION_CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".ogg": "video/ogg",
  ".ogv": "video/ogg",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
  ".3gp": "video/3gpp",
  ".3g2": "video/3gpp2",
};

function contentTypeFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname).toLowerCase();
    return VIDEO_EXTENSION_CONTENT_TYPES[ext] ?? "video/mp4";
  } catch {
    return "video/mp4";
  }
}

function isAllowedPlaybackUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const supabaseUrl = process.env["SUPABASE_URL"];
    const allowedSupabaseHost = supabaseUrl ? new URL(supabaseUrl).host : null;
    return (
      url.protocol === "https:" &&
      Boolean(allowedSupabaseHost) &&
      url.host === allowedSupabaseHost &&
      url.pathname.includes("/storage/v1/object/")
    );
  } catch {
    return false;
  }
}

/**
 * Resolve the content type to trust for a browser-supplied file. Prefers the
 * browser-reported mimetype when it's already one of our known video types,
 * and otherwise falls back to an extension-based guess. Returns null when
 * neither source identifies a supported video format.
 */
function resolveVideoContentType(file: { originalname: string; mimetype: string }): string | null {
  if (ALLOWED_VIDEO_TYPES.has(file.mimetype)) return file.mimetype;
  const ext = path.extname(file.originalname).toLowerCase();
  return VIDEO_EXTENSION_CONTENT_TYPES[ext] ?? null;
}

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
    cb(null, resolveVideoContentType(file) !== null);
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
// Video submission is available to any signed-in user (Tier 2), not just
// admins — the app-level requireAuth gate already blocks anonymous callers,
// and ingestLimiter + the multer size cap bound the abuse/cost surface.
router.post(
  "/videos/ingest",
  ingestLimiter,
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
      const uploader = await resolveIdentity(req);

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
          uploader_user_id: uploader?.userId ?? req.userId ?? null,
          uploader_email: uploader?.email ?? null,
          uploader_name: uploader?.name ?? uploader?.email ?? null,
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
          // fileFilter already guarantees a resolvable type; the mimetype
          // fallback here is just defensive.
          contentType: resolveVideoContentType(req.file) ?? req.file.mimetype,
          upsert: false,
        });

      if (uploadErr) {
        // Roll back the DB row if storage fails.
        await supabase.from("videos").delete().eq("id", video.id);

        // Supabase enforces a project-level "Upload file size limit" (Storage →
        // Settings) that rejects oversized objects with a 413 regardless of our
        // own 2 GB multer cap. Surface that as a clear, friendly message instead
        // of a generic 500 so the uploader knows the video is simply too large.
        if (isFileSizeLimitError(uploadErr)) {
          return res.status(413).json({
            error:
              "This video exceeds the storage plan's file size limit. Please upload a smaller file or ask an administrator to raise the Supabase storage upload limit.",
          });
        }
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

router.post("/videos", requireAdmin, aiPipelineLimiter, async (req, res) => {
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
    return res.json((data ?? []).map(toVideoResponse));
  } catch (err) {
    req.log.error({ err }, "getRecentVideos error");
    return res.status(500).json({ error: "Failed to get recent videos" });
  }
});

router.get("/videos/:id/play", async (req, res) => {
  try {
    const parsed = GetVideoParams.safeParse(req.params);
    if (!parsed.success) return res.status(400).json({ error: "Invalid id" });

    const { data, error } = await supabase
      .from("videos")
      .select("video_url")
      .eq("id", parsed.data.id)
      .maybeSingle();

    if (error) throw error;
    const videoUrl = typeof data?.["video_url"] === "string" ? data["video_url"] : "";
    if (!videoUrl) return res.status(404).json({ error: "Video source not found" });
    if (!isAllowedPlaybackUrl(videoUrl)) {
      return res.status(400).json({ error: "Unsupported video source" });
    }

    const upstreamHeaders: Record<string, string> = {};
    const range = req.headers.range;
    if (typeof range === "string") upstreamHeaders["range"] = range;

    const upstream = await fetch(videoUrl, { headers: upstreamHeaders });
    if (!upstream.ok && upstream.status !== 206) {
      req.log.warn({ status: upstream.status, videoId: parsed.data.id }, "video playback fetch failed");
      return res.status(upstream.status).send("Video source unavailable");
    }

    res.status(upstream.status);
    const contentType = upstream.headers.get("content-type") ?? "";
    res.setHeader(
      "Content-Type",
      contentType.startsWith("video/") ? contentType : contentTypeFromUrl(videoUrl),
    );
    res.setHeader("Accept-Ranges", upstream.headers.get("accept-ranges") ?? "bytes");
    for (const header of ["content-length", "content-range", "etag", "last-modified"]) {
      const value = upstream.headers.get(header);
      if (value) res.setHeader(header, value);
    }
    res.setHeader("Cache-Control", "private, max-age=300");

    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body).pipe(res);
    return;
  } catch (err) {
    req.log.error({ err }, "playVideo error");
    return res.status(500).json({ error: "Failed to play video" });
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
    const duplicateEligibility = await getDuplicateEligibility(data, req.userId);

    return res.json({
      id: data.id,
      title: data.title,
      description: data.description ?? null,
      trade: data.trade ?? null,
      thumbnailUrl: data.thumbnail_url ?? null,
      videoUrl: data.video_url ? `/api/videos/${data.id}/play` : null,
      duration: data.duration ?? null,
      status: data.status,
      competencyCodes: data.competency_codes ?? [],
      tags: data.tags ?? [],
      transcript: data.transcript ?? null,
      analysis: data.analysis ?? null,
      keyPoints: data.key_points ?? [],
      attempts: data.attempts ?? null,
      lastError: data.last_error ?? null,
      uploaderUserId: data.uploader_user_id ?? null,
      uploaderEmail: data.uploader_email ?? null,
      uploaderName: data.uploader_name ?? null,
      duplicateCount: duplicateEligibility.duplicateCount,
      canDeleteDuplicate: duplicateEligibility.canDeleteDuplicate,
      segments,
      createdAt: data.created_at,
      updatedAt: data.updated_at ?? null,
    });
  } catch (err) {
    req.log.error({ err }, "getVideo error");
    return res.status(500).json({ error: "Failed to get video" });
  }
});

router.post("/videos/:id/claim-contributor", requireAdmin, async (req, res) => {
  try {
    const parsed = GetVideoParams.safeParse(req.params);
    if (!parsed.success) return res.status(400).json({ error: "Invalid id" });

    const identity = await resolveIdentity(req);
    const userId = identity?.userId ?? req.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { data, error } = await supabase
      .from("videos")
      .update({
        uploader_user_id: userId,
        uploader_email: identity?.email ?? null,
        uploader_name: identity?.name ?? identity?.email ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", parsed.data.id)
      .select()
      .single();

    if (error) throw error;

    await syncGraphSafe(parsed.data.id);
    return res.json(toVideoResponse(data as Record<string, unknown>));
  } catch (err) {
    req.log.error({ err }, "claimVideoContributor error");
    return res.status(500).json({ error: "Failed to claim video contributor" });
  }
});

router.patch("/videos/:id", requireAdmin, async (req, res) => {
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

router.delete("/videos/:id", aiPipelineLimiter, async (req, res) => {
  try {
    const parsed = DeleteVideoParams.safeParse(req.params);
    if (!parsed.success) return res.status(400).json({ error: "Invalid id" });

    const identity = await resolveIdentity(req);
    const userId = identity?.userId ?? req.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { data: video, error: readError } = await supabase
      .from("videos")
      .select("id, title, trade, uploader_user_id")
      .eq("id", parsed.data.id)
      .maybeSingle();

    if (readError) throw readError;
    if (!video) return res.status(404).json({ error: "Video not found" });

    if (!identity?.isAdmin) {
      const duplicateEligibility = await getDuplicateEligibility(video, userId);
      if (!duplicateEligibility.canDeleteDuplicate) {
        return res.status(403).json({
          error: "Only duplicate videos uploaded by your own account can be removed.",
        });
      }
    }

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

router.post("/videos/:id/transcribe", aiPipelineLimiter, async (req, res) => {
  try {
    const parsed = TranscribeVideoParams.safeParse(req.params);
    if (!parsed.success) return res.status(400).json({ error: "Invalid id" });
    const videoId = parsed.data.id;
    const access = await canProcessVideo(videoId, req);
    if (!access.ok) return res.status(access.status).json({ error: access.error });

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

router.post("/videos/:id/analyze", aiPipelineLimiter, async (req, res) => {
  try {
    const parsed = AnalyzeVideoParams.safeParse(req.params);
    if (!parsed.success) return res.status(400).json({ error: "Invalid id" });
    const videoId = parsed.data.id;
    const access = await canProcessVideo(videoId, req);
    if (!access.ok) return res.status(access.status).json({ error: access.error });

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

router.post("/videos/:id/upload-url", requireAdmin, aiPipelineLimiter, async (req, res) => {
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
