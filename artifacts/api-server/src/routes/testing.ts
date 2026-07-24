import { Router, type Request } from "express";
import multer from "multer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { supabase } from "../lib/supabase.js";
import {
  getAdminReviewer,
  requireAdmin,
  resolveIdentity,
} from "../lib/admin-auth.js";
import { userTestingLimiter } from "../lib/rate-limit.js";
import { queueFeedbackNotification } from "../lib/feedback-notifications.js";

const router = Router();

const FEEDBACK_TRIGGERS = new Set([
  "logout",
  "interview_complete",
  "ask_jack_complete",
  "desktop_exit",
]);
const FEEDBACK_FEATURES = new Set([
  "ask_jack",
  "interview_mode",
  "memory_graph",
  "library",
  "knowledge_review",
  "video_detail",
]);
const DEVICE_CATEGORIES = new Set(["desktop", "tablet", "mobile"]);
const USEFUL_CHOICES = new Set(["yes", "partly", "no"]);
const FEEDBACK_BODY_KEYS = new Set([
  "feedbackId",
  "goal",
  "useful",
  "shortfall",
  "adoptionNeed",
  "additional",
  "featuresUsed",
  "sessionId",
  "deviceCategory",
  "trigger",
  "appVersion",
]);
const FEEDBACK_STATUSES = new Set(["new", "reviewed", "actioned", "archived"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function jsonString(
  body: Record<string, unknown>,
  key: string,
  maxLength: number,
  required = true,
): string | null | undefined {
  const value = body[key];
  if (value === null && !required) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if ((required && !trimmed) || trimmed.length > maxLength) return undefined;
  return trimmed || null;
}

function hasOnlyAllowedFeedbackKeys(body: Record<string, unknown>): boolean {
  return Object.keys(body).every((key) => FEEDBACK_BODY_KEYS.has(key));
}

function queueFeedbackAlert(req: Request, feedbackId: string): void {
  try {
    queueFeedbackNotification(feedbackId);
  } catch (err) {
    req.log.error({ err, feedbackId }, "failed to enqueue feedback notification");
  }
}

router.post("/testing/feedback", userTestingLimiter, async (req, res) => {
  try {
    const identity = await resolveIdentity(req);
    if (!identity?.userId || !identity.email) {
      return res.status(403).json({ error: "User-testing feedback requires a signed-in tester." });
    }
    if (identity.userId === "presentation-demo") {
      return res
        .status(403)
        .json({ error: "User-testing feedback is unavailable in presentation mode." });
    }
    const body = req.body as Record<string, unknown>;
    const feedbackId = jsonString(body, "feedbackId", 36);
    const goal = jsonString(body, "goal", 500);
    const useful = jsonString(body, "useful", 10);
    const shortfall = jsonString(body, "shortfall", 500);
    const adoptionNeed = jsonString(body, "adoptionNeed", 500);
    const additional = jsonString(body, "additional", 1_000, false);
    const sessionId = jsonString(body, "sessionId", 100);
    const device = jsonString(body, "deviceCategory", 20);
    const trigger = jsonString(body, "trigger", 40);
    const appVersion = jsonString(body, "appVersion", 120, false);
    const features = body["featuresUsed"];

    if (
      !feedbackId ||
      !UUID_RE.test(feedbackId) ||
      !goal ||
      !useful ||
      !USEFUL_CHOICES.has(useful) ||
      !shortfall ||
      !adoptionNeed ||
      additional === undefined ||
      !sessionId ||
      !device ||
      !DEVICE_CATEGORIES.has(device) ||
      !trigger ||
      !FEEDBACK_TRIGGERS.has(trigger) ||
      ["testerUserId", "testerEmail", "testerName", "testerProfileId", "testerTrade"].some(
        (key) => key in body,
      ) ||
      !Array.isArray(features) ||
      features.length === 0 ||
      features.length > FEEDBACK_FEATURES.size ||
      features.some((feature) => typeof feature !== "string" || !FEEDBACK_FEATURES.has(feature))
    ) {
      return res.status(400).json({ error: "Invalid user-testing feedback." });
    }

    const { data: profile, error: profileError } = await supabase
      .from("mentor_profiles")
      .select("id, trade")
      .eq("contributor_user_id", identity.userId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (profileError) throw profileError;

    if (!hasOnlyAllowedFeedbackKeys(body)) {
      return res.status(400).json({ error: "Invalid user-testing feedback." });
    }

    const { data: row, error } = await supabase
      .from("test_feedback")
      .insert({
        id: feedbackId,
        tester_user_id: identity.userId,
        tester_email: identity.email,
        tester_name: identity.name,
        tester_profile_id: profile?.id ?? null,
        tester_trade: profile?.trade ?? null,
        session_id: sessionId,
        features_used: [...new Set(features)],
        device_category: device,
        trigger,
        goal,
        useful,
        shortfall,
        adoption_need: adoptionNeed,
        additional,
        app_version: appVersion,
        status: "new",
        notification_status: "pending",
      })
      .select("id, created_at")
      .single();
    if (error) {
      if ((error as { code?: string }).code === "23505") {
        const { data: existing, error: existingError } = await supabase
          .from("test_feedback")
          .select("id, created_at")
          .eq("id", feedbackId)
          .eq("tester_user_id", identity.userId)
          .maybeSingle();
        if (existingError) throw existingError;
        if (!existing) {
          return res.status(409).json({ error: "Feedback id is already in use." });
        }
        queueFeedbackAlert(req, existing.id);
        return res.status(200).json({ id: existing.id, createdAt: existing.created_at });
      }
      throw error;
    }
    queueFeedbackAlert(req, row.id);
    return res.status(201).json({ id: row.id, createdAt: row.created_at });
  } catch (err) {
    req.log.error({ err }, "submitTestFeedback error");
    return res.status(500).json({ error: "Failed to save feedback." });
  }
});

type FeedbackRecord = Record<string, unknown>;

function serializeFeedback(row: FeedbackRecord) {
  return {
    id: row["id"],
    testerUserId: row["tester_user_id"],
    testerEmail: row["tester_email"],
    testerName: row["tester_name"],
    testerProfileId: row["tester_profile_id"],
    trade: row["tester_trade"],
    sessionId: row["session_id"],
    featuresUsed: row["features_used"],
    deviceCategory: row["device_category"],
    trigger: row["trigger"],
    goal: row["goal"],
    usefulness: row["useful"],
    shortfall: row["shortfall"],
    adoptionNeed: row["adoption_need"],
    additional: row["additional"],
    appVersion: row["app_version"],
    status: row["status"],
    adminNotes: row["admin_notes"],
    reviewedBy: row["reviewed_by"],
    reviewedAt: row["reviewed_at"],
    notificationStatus: row["notification_status"],
    notificationAttempts: row["notification_attempts"],
    notificationLastError: row["notification_last_error"],
    notificationLastAttemptAt: row["notification_last_attempt_at"],
    notificationNextAttemptAt: row["notification_next_attempt_at"],
    notificationSentAt: row["notification_sent_at"],
    createdAt: row["created_at"],
    updatedAt: row["updated_at"],
  };
}

function queryString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function routeParam(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

router.get("/testing/feedback", requireAdmin, async (req, res) => {
  const trade = queryString(req.query["trade"]);
  const status = queryString(req.query["status"]);
  const usefulness = queryString(req.query["usefulness"]);
  const dateFrom = queryString(req.query["dateFrom"]);
  const dateTo = queryString(req.query["dateTo"]);
  if (status && !FEEDBACK_STATUSES.has(status)) {
    return res.status(400).json({ error: "Invalid feedback status." });
  }
  if (usefulness && !USEFUL_CHOICES.has(usefulness)) {
    return res.status(400).json({ error: "Invalid usefulness response." });
  }
  if (dateFrom && Number.isNaN(Date.parse(dateFrom))) {
    return res.status(400).json({ error: "Invalid start date." });
  }
  if (dateTo && Number.isNaN(Date.parse(dateTo))) {
    return res.status(400).json({ error: "Invalid end date." });
  }

  try {
    let query = supabase
      .from("test_feedback")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(250);
    if (trade) query = query.eq("tester_trade", trade);
    if (status) query = query.eq("status", status);
    if (usefulness) query = query.eq("useful", usefulness);
    if (dateFrom) query = query.gte("created_at", new Date(dateFrom).toISOString());
    if (dateTo) {
      const end = new Date(dateTo);
      if (/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) end.setUTCDate(end.getUTCDate() + 1);
      query = query.lt("created_at", end.toISOString());
    }
    const [{ data, error }, { data: newRows, error: countError }] = await Promise.all([
      query,
      supabase.from("test_feedback").select("id").eq("status", "new"),
    ]);
    if (error) throw error;
    if (countError) throw countError;
    const feedback = (data ?? []).map((row) => serializeFeedback(row as FeedbackRecord));
    const trades = [
      ...new Set(
        (data ?? [])
          .map((row) => (row as FeedbackRecord)["tester_trade"])
          .filter((value): value is string => typeof value === "string" && value.length > 0),
      ),
    ].sort();
    return res.json({ feedback, unreadCount: newRows?.length ?? 0, trades });
  } catch (err) {
    req.log.error({ err }, "listTestFeedback error");
    return res.status(500).json({ error: "Failed to load user-test feedback." });
  }
});

router.get("/testing/feedback/:id", requireAdmin, async (req, res) => {
  const feedbackId = routeParam(req.params["id"]);
  if (!UUID_RE.test(feedbackId)) {
    return res.status(400).json({ error: "Invalid feedback id." });
  }
  try {
    const { data, error } = await supabase
      .from("test_feedback")
      .select("*")
      .eq("id", feedbackId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Feedback not found." });
    return res.json(serializeFeedback(data as FeedbackRecord));
  } catch (err) {
    req.log.error({ err }, "getTestFeedback error");
    return res.status(500).json({ error: "Failed to load user-test feedback." });
  }
});

router.patch("/testing/feedback/:id", requireAdmin, async (req, res) => {
  const feedbackId = routeParam(req.params["id"]);
  if (!UUID_RE.test(feedbackId)) {
    return res.status(400).json({ error: "Invalid feedback id." });
  }
  const body = req.body as Record<string, unknown>;
  const status = typeof body["status"] === "string" ? body["status"].trim() : "";
  const notesValue = body["adminNotes"];
  const adminNotes =
    notesValue === null
      ? null
      : typeof notesValue === "string" && notesValue.trim().length <= 4_000
        ? notesValue.trim() || null
        : undefined;
  if (!FEEDBACK_STATUSES.has(status) || adminNotes === undefined) {
    return res.status(400).json({ error: "Invalid feedback update." });
  }

  try {
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from("test_feedback")
      .update({
        status,
        admin_notes: adminNotes,
        reviewed_by: status === "new" ? null : getAdminReviewer(req),
        reviewed_at: status === "new" ? null : now,
        updated_at: now,
      })
      .eq("id", feedbackId)
      .select("*")
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Feedback not found." });
    return res.json(serializeFeedback(data as FeedbackRecord));
  } catch (err) {
    req.log.error({ err }, "updateTestFeedback error");
    return res.status(500).json({ error: "Failed to update user-test feedback." });
  }
});

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
