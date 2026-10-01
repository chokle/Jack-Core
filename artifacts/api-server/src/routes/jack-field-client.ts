import { Router, type RequestHandler } from "express";
import multer from "multer";
import { rateLimit } from "express-rate-limit";
import { requirePilotAccess } from "../middlewares/requirePilotAccess.js";
import { transcribeAudioBuffer } from "../lib/transcription.js";
import { readableVideos } from "../lib/library-read-policy.js";
import { supabase } from "../lib/supabase.js";
import { readKnowledgeMeta } from "../lib/knowledge-schema.js";
import {
  knowledgeEntryScopeAllowed,
  resolveKnowledgeScope,
} from "../lib/knowledge-read-policy.js";

const router = Router();
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const TRANSCRIPTION_TIMEOUT_MS = 30_000;
const unavailable = {
  code: "JACK_TRANSCRIPTION_UNAVAILABLE",
  error: "Transcription is unavailable. You can still type your question.",
};
const audioExtensions = new Map([
  ["audio/mp4", "m4a"],
  ["audio/m4a", "m4a"],
  ["audio/x-m4a", "m4a"],
  ["audio/aac", "m4a"],
  ["audio/webm", "webm"],
  ["audio/ogg", "ogg"],
  ["audio/mpeg", "mp3"],
  ["audio/mp3", "mp3"],
  ["audio/wav", "wav"],
  ["audio/x-wav", "wav"],
  ["audio/flac", "flac"],
]);

// App-level gates also protect these paths. Keep the bare router fail-closed,
// and run membership checks before parsing private audio or calling providers.
const requireNativeAccess: RequestHandler = (req, res, next) => {
  // Route handlers preserve the API-relative path for the shared gate,
  // including every case/trailing-slash spelling Express accepts.
  res.setHeader("Cache-Control", "private, no-store");
  if (!req.userId) {
    res.status(401).json({ error: "Unauthorized — sign in required." });
    return;
  }
  requirePilotAccess(req, res, next);
};

const transcriptionLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => req.userId!,
  message: unavailable,
});
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AUDIO_BYTES, files: 1, fields: 0 },
  fileFilter: (_req, file, callback) => {
    const mime = file.mimetype.toLowerCase().split(";")[0]!.trim();
    if (!audioExtensions.has(mime)) {
      callback(new Error("Unsupported audio type"));
      return;
    }
    callback(null, true);
  },
}).single("audio");

router.post(
  "/jack/transcribe",
  requireNativeAccess,
  transcriptionLimiter,
  (req, res) => {
    upload(req, res, (error: unknown) => {
      if (error) {
        const oversized =
          error instanceof multer.MulterError &&
          error.code === "LIMIT_FILE_SIZE";
        res.status(oversized ? 413 : 400).json({
          error: oversized
            ? "Audio must be 8 MiB or smaller."
            : "Provide one supported audio file.",
        });
        return;
      }
      const file = req.file;
      if (!file?.buffer.length) {
        res.status(400).json({ error: "A nonempty audio file is required." });
        return;
      }
      const mime = file.mimetype.toLowerCase().split(";")[0]!.trim();
      const filename = `question.${audioExtensions.get(mime)!}`;
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        TRANSCRIPTION_TIMEOUT_MS,
      );
      const cancel = () => controller.abort();
      let rejectAborted!: () => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectAborted = () => reject(new Error("Transcription cancelled"));
      });
      controller.signal.addEventListener("abort", rejectAborted, {
        once: true,
      });
      res.on("close", cancel);
      void (async () => {
        try {
          const text = await Promise.race([
            transcribeAudioBuffer(file.buffer, filename, {
              signal: controller.signal,
              timeout: TRANSCRIPTION_TIMEOUT_MS,
              maxRetries: 0,
            }),
            aborted,
          ]);
          if (!res.destroyed && !controller.signal.aborted) {
            if (!text.trim())
              res.status(422).json({
                error:
                  "No speech was detected. Try again or type your question.",
              });
            else res.json({ text });
          } else if (!res.destroyed) res.status(503).json(unavailable);
        } catch {
          // No recording/transcript/provider diagnostics are logged or ingested.
          if (!res.destroyed) res.status(503).json(unavailable);
        } finally {
          clearTimeout(timer);
          res.off("close", cancel);
          controller.signal.removeEventListener("abort", rejectAborted);
          file.buffer.fill(0);
          delete req.file;
        }
      })();
    });
  },
);

router.get("/jack/sources/:kind/:id", requireNativeAccess, async (req, res) => {
  const { kind, id } = req.params;
  if (
    (kind !== "video" && kind !== "knowledge") ||
    typeof id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  ) {
    res.status(400).json({ error: "Invalid source." });
    return;
  }
  try {
    if (kind === "video") {
      const { data, error } = await readableVideos(req.userId)
        .select("id, title, description, transcript, video_url")
        .eq("id", id)
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        res.status(404).json({ error: "Source not found." });
        return;
      }
      res.json({
        title: data.title,
        text: data.transcript || data.description || "",
        ...(data.video_url ? { videoUrl: `/api/videos/${id}/play` } : {}),
      });
      return;
    }
    const scope = await resolveKnowledgeScope(req.userId!);
    const { data, error } = await supabase
      .from("knowledge_entries")
      .select("title, description, body, metadata")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    // Graph-memory citations also carry entryId, but knowledge_nodes have no
    // canonical viewer scope policy here. Never fall through to global nodes.
    if (
      !data ||
      !knowledgeEntryScopeAllowed(readKnowledgeMeta(data.metadata), scope)
    ) {
      res.status(404).json({ error: "Source not found." });
      return;
    }
    res.json({
      title: data.title,
      text: [data.description, data.body].filter(Boolean).join("\n\n"),
    });
  } catch {
    res.status(503).json({ error: "Source is unavailable." });
  }
});

export default router;
