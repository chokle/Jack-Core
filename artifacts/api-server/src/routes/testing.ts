import { Router } from "express";
import multer from "multer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { supabase } from "../lib/supabase.js";
import { resolveIdentity } from "../lib/admin-auth.js";
import { userTestingLimiter } from "../lib/rate-limit.js";

const router = Router();

/**
 * Beta user-testing mode — consent-recorded tester screen (+ optional mic)
 * sessions. This is OPERATIONAL/testing data, never written into the public
 * Living Memory knowledge graph. Follows the same server-proxied-upload shape
 * as POST /videos/ingest (disk-spooled multer -> Supabase Storage using the
 * service-role key), but writes into a PRIVATE bucket and never returns/stores
 * a public URL, since a screen recording can capture arbitrary on-screen
 * content. Deliberately outside the OpenAPI/Orval contract, matching the
 * existing precedent for multipart upload routes in this codebase.
 */

const ALLOWED_RECORDING_TYPES = new Set([
  "video/webm",
  "video/mp4",
  "video/x-matroska",
  "video/ogg",
]);

const UPLOAD_TMP_DIR = path.join(os.tmpdir(), "jack-test-recordings");
fs.mkdirSync(UPLOAD_TMP_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_TMP_DIR,
    filename: (_req, _file, cb) => {
      cb(null, `test-recording-${Date.now()}-${crypto.randomUUID()}`);
    },
  }),
  // Screen recordings of a full testing session can run long; 500 MB comfortably
  // covers a session at typical webm bitrates while still bounding storage cost.
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, ALLOWED_RECORDING_TYPES.has(file.mimetype));
  },
});

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

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

function intField(body: Record<string, unknown>, key: string): number | undefined {
  const v = body[key];
  if (typeof v !== "string") return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * POST /testing/recordings — upload one completed beta-testing recording.
 *
 * Accepts multipart/form-data with fields:
 *   file              — the recorded video/audio blob (required)
 *   sessionId         — client-generated id grouping this recording (required)
 *   screenResolution, appVersion, durationMs — optional metadata
 *
 * requireAuth (app-level) already ensures req.userId is set. tester identity
 * is resolved server-side from the Clerk session — never taken from the body.
 */
router.post(
  "/testing/recordings",
  userTestingLimiter,
  upload.single("file"),
  async (req, res) => {
    const tempPath = req.file?.path;
    try {
      if (!req.file || !tempPath) {
        return res.status(400).json({ error: "A recording file is required." });
      }

      const sessionId = stringField(req.body, "sessionId");
      if (!sessionId) return res.status(400).json({ error: "sessionId is required." });

      const identity = await resolveIdentity(req);

      const filename = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
      const recordingId = crypto.randomUUID();
      const storagePath = `recordings/${recordingId}/${filename}`;

      const { error: uploadErr } = await supabase.storage
        .from("jack-test-recordings")
        .upload(storagePath, fs.createReadStream(tempPath), {
          contentType: req.file.mimetype,
          upsert: false,
        });

      if (uploadErr) {
        if (isFileSizeLimitError(uploadErr)) {
          return res.status(413).json({
            error:
              "This recording exceeds the storage plan's file size limit. Please try a shorter session.",
          });
        }
        throw uploadErr;
      }

      // Only the private storage_path is stored — never a public URL — since a
      // screen recording can contain arbitrary on-screen content.
      const { data: row, error: insertErr } = await supabase
        .from("test_recordings")
        .insert({
          id: recordingId,
          tester_user_id: identity?.userId ?? req.userId ?? null,
          tester_email: identity?.email ?? null,
          session_id: sessionId,
          storage_path: storagePath,
          mime_type: req.file.mimetype,
          duration_ms: intField(req.body, "durationMs") ?? null,
          size_bytes: req.file.size,
          user_agent: stringField(req.body, "userAgent") ?? null,
          screen_resolution: stringField(req.body, "screenResolution") ?? null,
          app_version: stringField(req.body, "appVersion") ?? null,
        })
        .select("id, created_at")
        .single();

      if (insertErr) {
        // Roll back the uploaded object if we can't record its metadata.
        await supabase.storage.from("jack-test-recordings").remove([storagePath]);
        throw insertErr;
      }

      return res.status(201).json({ id: row.id, createdAt: row.created_at });
    } catch (err) {
      req.log.error({ err }, "uploadTestRecording error");
      return res.status(500).json({ error: "Failed to upload recording" });
    } finally {
      if (tempPath) {
        fs.promises.unlink(tempPath).catch((err) => {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            req.log.warn({ err, tempPath }, "failed to remove test-recording temp file");
          }
        });
      }
    }
  },
);

export default router;
