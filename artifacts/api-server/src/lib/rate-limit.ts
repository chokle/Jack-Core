import { rateLimit, ipKeyGenerator } from "express-rate-limit";

/** Normalize the client IP into a rate-limit key. `ipKeyGenerator` collapses an
 *  IPv6 address to its /64 subnet so a single client can't cycle low-order bits
 *  to evade the limit; a missing IP falls back to a shared bucket. */
const keyGenerator = (req: { ip?: string }): string =>
  ipKeyGenerator(req.ip ?? "unknown");

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
  keyGenerator,
});

/**
 * Rate limiter for POST /videos/ingest — the bulk-capable upload route.
 * Onboarding a library (20–50 clips in one session) would trip the 10/15min
 * aiPipelineLimiter almost immediately. This route is admin-gated
 * (requireAdminSession) and each request also passes through the server-side
 * pipeline concurrency gate, so a higher ceiling is safe: 120 requests per 15
 * minutes per IP supports a real bulk upload while still capping automation.
 */
export const ingestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many uploads — please try again later." },
  keyGenerator,
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
  keyGenerator,
});

/**
 * Rate limiter for Interview Mode endpoints. Starting a session, submitting an
 * answer, and skipping each call the chat model (next-question generation) and,
 * for answers, the distillation model — all paid. A conversational interview is
 * inherently many small turns, so this is more generous than the pipeline limiter
 * (120 requests per 15 minutes per IP) while still capping automated abuse.
 */
export const aiInterviewLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many interview requests — please slow down." },
  keyGenerator,
});

/**
 * Rate limiter for POST /parking-lot. This endpoint calls no paid model, but
 * it is a public write that stores caller-supplied jsonb into Supabase —
 * unbounded calls could still grow storage without limit. 30 requests per 15
 * minutes per IP is generous for legitimate "park this thought" use while
 * blocking automated flooding.
 */
export const parkingLotLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many requests — please try again later." },
  keyGenerator,
});
