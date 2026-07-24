# Architecture

Jack is a single-page AI Trade Intelligence Engine for skilled trades workers — a searchable, queryable video knowledge library that transcribes training videos, maps them to Red Seal competencies, and answers questions with timestamp citations.

This file is the authoritative "how it's built" detail. For the "why" and priorities, see [`../VISION.md`](../VISION.md); for Jack's answer rules, see [`../JACK_CONSTITUTION.md`](../JACK_CONSTITUTION.md). Knowledge-graph mechanics (ingestion bands, Knowledge Review, Mentor Withdrawal) have their own file: [`./knowledge-graph.md`](./knowledge-graph.md).

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React + Vite (single-page, `artifacts/jack-core/`)
- API: Express 5 (`artifacts/api-server/`)
- Database: Supabase (PostgreSQL + pgvector for embeddings)
- Storage: Supabase Storage (`jack-videos` bucket)
- AI: OpenAI Whisper (transcription) + GPT-4o (analysis + Ask Jack) + text-embedding-3-small (RAG)
- Validation: Zod (`zod/v4`), Orval codegen

## Architecture decisions

- Single-page React app with conditional rendering (no multi-page routing) — Library → VideoDetail → overlaid AskJack drawer
- Supabase is the single source of truth for all persistence: videos, transcript_segments, chat_messages, competencies tables
- Every `/api` route is fail-closed behind Clerk authentication; only the root/health endpoints and CORS preflight are public. Admin routes also enforce the configured `ADMIN_EMAILS` allowlist server-side.
- pgvector (1536-dim, text-embedding-3-small) powers both semantic search and related-video discovery
- Video processing is a resilient in-process job system (`artifacts/api-server/src/lib/jobs.ts`): all job state is durable on the videos row (`status`, `processing_stage`, `attempts`, `last_error`, `heartbeat_at`, `claimed_by`, `next_attempt_at`), so a server restart never strands a video. Lifecycle: queued → uploading → uploaded → transcribing → analyzing → indexing → completed, with `failed` (terminal) and `retrying` (capped backoff: 3 attempts, 30s·2^(n-1) capped at 5m). A startup recovery sweep + 60s watchdog reclaim orphaned/stale rows (heartbeat older than 5m) via atomic conditional updates and resume from the START of the stage — every stage is idempotent (transcribe: segments delete-then-insert; analyze: overwrite; index: overwrite + deterministic graph sync). `uploading` is client-owned: the server never resumes it, only TTL-fails it after 2h. Analysis exhaustion is a deliberate exception — the pipeline continues to indexing/completed without analysis so a GPT hiccup never downgrades a usable transcript
- **Knowledge writes are strictly verified — indexing is no longer best-effort.** At the END of indexing, after the graph sync + distillation, `verifyAndRecordGraphWrite` (`memory-graph.ts`) confirms the write actually landed — nodes exist, edges created, provenance stored, confidence recomputed, search index updated — and records the outcome (`verified`/`partial`/`failed`) to the `knowledge_write_log` table. Anything short of `verified` THROWS, so the video routes to `retrying`/`failed` instead of silently completing with its knowledge missing from the graph. This deliberately REVERSES the earlier best-effort indexing (a swallowed graph error used to still complete the video). Recovery is retry-forward only — shared/canonical nodes are never rolled back, because re-sync is idempotent and other videos/mentors may already reference them. Mentor answers are verified the same way inline at submission (`distillation_status` stamped on the answer row); `POST /interview/answers/:id/redistill` re-runs it. Failures surface on the admin Graph Health dashboard only (no email/alerting)
- Jack always searches the internal library (pgvector RAG) before answering — `usedInternalKnowledge` flag in responses
- Red Seal competency codes are seeded from a canonical list and mapped by GPT-4o during analysis
- Consented pilot feedback is written to Supabase before any alert is attempted. A durable notification state on the feedback row drives an immediate Resend worker with retry/backoff and provider idempotency; the admin Review record remains authoritative if email is unavailable.

The knowledge-graph decisions (Interview Mode reuse of the distillation pipeline, video vs. mentor ingestion bands, Knowledge Review resolution + drift resilience, Mentor Withdrawal, and graph persistence) live in [`./knowledge-graph.md`](./knowledge-graph.md).
