import { rateLimit } from "express-rate-limit";

/**
 * Rate limiter for expensive AI/media pipeline endpoints:
 * POST /videos, POST /videos/:id/upload-url, POST /videos/:id/transcribe,
 * POST /videos/:id/analyze, DELETE /videos/:id
 *
 * Each of these triggers paid OpenAI or heavy media processing work.
 * 10 requests per 15 minutes per IP is generous for legitimate use
 * while making bulk automation economically unviable.
 */
export const aiPipelineLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many requests — please try again later." },
  keyGenerator: (req) => req.ip ?? "unknown",
});

/**
 * Rate limiter for chat and semantic search endpoints.
 * Each request calls OpenAI embeddings plus optionally a chat completion.
 * 30 requests per minute per IP allows normal interactive use while
 * blocking automated flooding.
 */
export const aiQueryLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many requests — please slow down." },
  keyGenerator: (req) => req.ip ?? "unknown",
});
