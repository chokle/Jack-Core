import { Router } from "express";
import { rateLimit } from "express-rate-limit";

const router = Router();
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const unavailable = {
  code: "JACK_VOICE_UNAVAILABLE",
  error: "Jack's voice is unavailable. You can still read his response.",
};

// Mounted behind the app auth/pilot gates; also fail closed when used alone.
router.use("/jack/speech", (req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  if (!req.userId) {
    res.status(401).json({ error: "Unauthorized — sign in required." });
    return;
  }
  next();
});

const speechLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => req.userId!,
  message: unavailable,
});

router.post("/jack/speech", speechLimiter, async (req, res) => {
  const text = req.body?.text;
  if (typeof text !== "string" || !text.trim() || text.length > 5000) {
    res
      .status(400)
      .json({ error: "Speech text must contain 1–5000 characters." });
    return;
  }
  const apiKey = process.env["ELEVENLABS_API_KEY"]?.trim();
  const voiceId = process.env["JACK_VOICE_ID"]?.trim();
  if (!apiKey || !voiceId || !/^[a-zA-Z0-9_-]+$/.test(voiceId)) {
    res.status(503).json(unavailable);
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  const cancel = () => controller.abort();
  res.on("close", cancel);
  try {
    const upstream = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          text: text.trim(),
          model_id: "eleven_multilingual_v2",
        }),
        signal: controller.signal,
      },
    );
    if (
      !upstream.ok ||
      !upstream.headers.get("content-type")?.startsWith("audio/mpeg") ||
      !upstream.body
    ) {
      await upstream.body?.cancel();
      throw new Error("Voice provider unavailable");
    }
    const reader = upstream.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_AUDIO_BYTES) {
        await reader.cancel();
        throw new Error("Voice response too large");
      }
      chunks.push(value);
    }
    if (!size) throw new Error("Empty voice response");
    if (!res.destroyed && !controller.signal.aborted) {
      res.type("audio/mpeg").send(Buffer.concat(chunks));
    }
  } catch {
    // Never log provider bodies, credentials, or private spoken text.
    if (!res.destroyed) res.status(503).json(unavailable);
  } finally {
    clearTimeout(timer);
    res.off("close", cancel);
  }
});

export default router;
