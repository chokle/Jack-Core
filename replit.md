# Jack — AI Trade Intelligence Engine

Jack is a single-page AI Trade Intelligence Engine for skilled trades workers — a searchable, queryable video knowledge library that transcribes training videos, maps them to Red Seal competencies, and answers questions with timestamp citations.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm --filter @workspace/jack-core run dev` — run the frontend (port 22659)
- `pnpm --filter @workspace/scripts run setup:supabase` — apply the Supabase schema (tables, functions, seed data, storage bucket)
- `pnpm --filter @workspace/api-server run seed:knowledge` — seed the sample non-video Knowledge Entries (data-driven `ENTRIES` array across trades; uploads any images, embeds, upserts by stable ids; idempotent)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React + Vite (single-page, `artifacts/jack-core/`)
- API: Express 5 (`artifacts/api-server/`)
- Database: Supabase (PostgreSQL + pgvector for embeddings)
- Storage: Supabase Storage (`jack-videos` bucket)
- AI: OpenAI Whisper (transcription) + GPT-4o (analysis + Ask Jack) + text-embedding-3-small (RAG)
- Validation: Zod (`zod/v4`), Orval codegen

## Where things live

- `artifacts/api-server/src/lib/session.ts` — shared HttpOnly `jack_session` cookie helpers (`resolveSession`/`readSession`/`SESSION_COOKIE`/`COOKIE_OPTS`), extracted so `chat.ts` and `parking-lot.ts` share one session-scoping implementation
- `artifacts/api-server/src/routes/parking-lot.ts` — Parking Lot endpoints: `POST /parking-lot` (park), `GET /parking-lot` (list, filterable by `status`/`mentorProfileId`), `POST /parking-lot/:id/resume`, `POST /parking-lot/:id/archive`. Rate-limited (`parkingLotLimiter`, 30/15min)
- `artifacts/jack-core/src/components/ParkedThoughts.tsx` — shared Parking Lot UI: `ParkThisThoughtButton` (the "Park This Thought" popover, used from Ask Jack and Interview Mode) and `ParkedThoughtsList` (the list card — used unfiltered in the Living Memory sidebar and filtered by `mentorProfileId` in a mentor node's detail panel). Also owns the one-shot `jack.interview.resumeNote` localStorage handoff that carries a parked interview thought's reason/unfinished-thought into Interview Mode's reorientation banner
- `lib/api-spec/openapi.yaml` — single source of truth for all API contracts
- `lib/api-client-react/src/generated/` — generated React Query hooks (don't edit)
- `lib/api-zod/src/generated/` — generated Zod schemas (don't edit)
- `artifacts/jack-core/src/` — React frontend (Library, VideoDetail, AskJack, UploadModal)
- `artifacts/api-server/src/routes/` — Express route handlers (videos, search, chat, competencies)
- `artifacts/api-server/src/lib/supabase.ts` — Supabase client
- `artifacts/api-server/src/lib/openai.ts` — OpenAI client
- `knowledge_entries` (table + `match_knowledge_entries` RPC in `scripts/src/supabase-schema.sql`) — generic, NON-video knowledge assets (written field notes, sketches, photos). Retrieval is table-driven, not hardcoded. `chat.ts` searches it with the SAME query embedding as transcripts and merges hits into Ask Jack's context + citations; `artifacts/api-server/src/scripts/seed-knowledge-entry.ts` is the (data-driven) manual create path — there is no ingestion UI
- `artifacts/api-server/src/lib/knowledge-schema.ts` — the Knowledge Object richer-metadata schema (Phase 1): `KnowledgeObjectMeta` type (all fields OPTIONAL, stored inside the existing `knowledge_entries.metadata` JSONB — no migration), the `KNOWLEDGE_OBJECT_FIELDS` key list, and `readKnowledgeMeta()` (graceful, non-lossy reader). `trade`/`tags` are already first-class columns so they are NOT re-declared here. Retrieval is untouched (`match_knowledge_entries` still doesn't return metadata); this only defines the shape the seed/store path uses. Wired into `seed-knowledge-entry.ts`'s `Entry.metadata` type
- `artifacts/api-server/src/lib/jobs.ts` — resilient job system (stage claiming, pipeline driver, retry/backoff, startup recovery sweep + watchdog)
- `artifacts/jack-core/src/lib/video-status.ts` — shared client-side IN_FLIGHT_STATUSES set (drives polling + UI states)
- `artifacts/jack-core/src/lib/graph-perf.ts` — pure, unit-tested perf-path geometry for the Living Memory canvas (spatial-grid repulsion threshold + cell math, padded viewport cull bounds, glow/topic LOD thresholds); `MemoryGraphCanvas` imports these so drawn and tested behavior can't drift
- `artifacts/jack-core/src/lib/graph-stress.ts` — `buildSyntheticServerGraph(n)`: synthetic large graph for exercising the canvas large-graph paths; used by the dev-only `?graphStress=N` toggle (in `use-memory-graph.ts`, DEV-gated, capped 5000) and by `graph-perf.test.ts`
- `artifacts/jack-core/src/lib/graph-spatial.ts` — pure, unit-tested 2.5D spatial geometry for the Living Memory navigator (no three.js): `MAJOR_TRADES` (the 12 major Red Seal trades), `withSeededTrades(model)` (injects the 12 trade hubs into the DISPLAYED model — first 5 reuse the exact seeded labels so `topic:<label>` ids collapse onto existing hubs; the rest render as empty "virgin" clusters — then re-runs `finalizeModel`), `buildAdjacency`/`buildHierarchy`, `fibonacciSphereDir`, `buildSpatialLayout` (shell radii by hop distance), `rotatePoint`/`projectPoint` (perspective, FOCAL=820/CAMERA_DISTANCE=620), `clampPitch` (±60°), `depthCue`, plus the perf caps (`DEFAULT_MAX_HOPS`, `DEFAULT_MAX_VISIBLE`). Imported by `SpatialBrainCanvas` so drawn and tested behavior can't drift
- `artifacts/jack-core/src/components/SpatialBrainCanvas.tsx` — the 2.5D spatial navigator; a drop-in contract sibling of `MemoryGraphCanvas` (identical `MemoryGraphHandle` + props) that renders the graph on an orbit camera (`{yaw,pitch,zoom}`): pointer-drag orbit, 2-pointer pinch + wheel zoom, double-click pin, click-to-lock recentering (selecting a node recenters on it; empty space recenters on the JACK core). Depth-sorted draw with virgin trade hubs shown as a dashed ring + "+ be the first". `MemoryGraphView` renders this instead of `MemoryGraphCanvas` (which is left untouched for rollback safety) and applies `withSeededTrades` ONCE via `useMemo` (the delta stream stays derived from the RAW model, so a freshly-seeded empty trade never fires a "Jack just learned…" toast); a virgin trade's node detail shows a "Be the first — teach Jack" CTA that opens Interview Mode
- `scripts/src/setup-supabase.ts` — Supabase schema setup script/reference
- `artifacts/api-server/src/lib/memory-graph.ts` — knowledge-graph persistence (node/edge sync, self-heal, rebuild)
- `artifacts/api-server/src/routes/graph.ts` — `GET /graph` (persisted Living Memory graph)
- `artifacts/api-server/src/routes/interview.ts` — Interview Mode endpoints (start session, get, submit/skip answer, finish), the public `GET /interview/mentors/:id/active-session` (a mentor's in-progress/incomplete interview — powers "Resume Interview" on their Living Memory node), plus the admin-gated `GET /interview/mentors` (mentor roster with session/answer counts), `POST /interview/mentors/:id/withdraw` (Mentor Withdrawal), and the admin-gated `POST /interview/answers/:id/redistill` (re-run distillation + knowledge-write verification for one answer). Answer submission distills + verifies inline and stamps `distillation_status` on the answer row
- `artifacts/jack-core/src/components/MentorWithdrawal.tsx` — admin-only mentor roster on the Review screen with a confirm-guarded destructive Withdraw action; surfaces the retained/archived/deleted/scrubbed summary after withdrawal
- `artifacts/api-server/src/routes/graph.ts` — also serves `GET /graph/candidates` (queued mentor-concept candidates, filterable by status; `pending` reads are public, non-pending statuses carry resolution details and require the admin session) and `POST /graph/candidates/:id/resolve` (admin-gated Knowledge Review: accept/merge/reject)
- `artifacts/api-server/src/routes/graph.ts` — also serves the admin-gated `GET /graph/health` (Graph Health: knowledge-write verified/partial/failed/pending counts, retry-queue depth, avg processing time, recent-write log with per-check detail)
- `artifacts/jack-core/src/components/KnowledgeReview.tsx` — Knowledge Review UI (admin-gated candidate curation: Accept / Merge into… / Reject with reason)
- `artifacts/jack-core/src/components/GraphHealth.tsx` — admin-only Graph Health dashboard on the Review screen; summary counts, retry queue, recent-write log with per-check pills, and a one-click Retry distillation on failed mentor answers
- `artifacts/jack-core/src/components/PendingKnowledgePanel.tsx` — read-only "Awaiting Knowledge Review" panel in the Living Memory right rail (public: title, category, mentor, near-matches; no resolution controls)
- `artifacts/api-server/src/lib/interview.ts` — interview trades/categories + next-question engine (GPT-4o with deterministic fallback)
- `artifacts/jack-core/src/components/InterviewMode.tsx` — Interview Mode UI (intake → conversation → completion)
- `artifacts/jack-core/src/lib/memory-graph.ts` — client graph model (`buildGraphModelFromServer` + client-derived fallback)

## Architecture decisions

- Single-page React app with conditional rendering (no multi-page routing) — Library → VideoDetail → overlaid AskJack drawer
- Supabase is the single source of truth for all persistence: videos, transcript_segments, chat_messages, competencies tables
- pgvector (1536-dim, text-embedding-3-small) powers both semantic search and related-video discovery
- Video processing is a resilient in-process job system (`artifacts/api-server/src/lib/jobs.ts`): all job state is durable on the videos row (`status`, `processing_stage`, `attempts`, `last_error`, `heartbeat_at`, `claimed_by`, `next_attempt_at`), so a server restart never strands a video. Lifecycle: queued → uploading → uploaded → transcribing → analyzing → indexing → completed, with `failed` (terminal) and `retrying` (capped backoff: 3 attempts, 30s·2^(n-1) capped at 5m). A startup recovery sweep + 60s watchdog reclaim orphaned/stale rows (heartbeat older than 5m) via atomic conditional updates and resume from the START of the stage — every stage is idempotent (transcribe: segments delete-then-insert; analyze: overwrite; index: overwrite + deterministic graph sync). `uploading` is client-owned: the server never resumes it, only TTL-fails it after 2h. Analysis exhaustion is a deliberate exception — the pipeline continues to indexing/completed without analysis so a GPT hiccup never downgrades a usable transcript
- **Knowledge writes are strictly verified — indexing is no longer best-effort.** At the END of indexing, after the graph sync + distillation, `verifyAndRecordGraphWrite` (`memory-graph.ts`) confirms the write actually landed — nodes exist, edges created, provenance stored, confidence recomputed, search index updated — and records the outcome (`verified`/`partial`/`failed`) to the `knowledge_write_log` table. Anything short of `verified` THROWS, so the video routes to `retrying`/`failed` instead of silently completing with its knowledge missing from the graph. This deliberately REVERSES the earlier best-effort indexing (a swallowed graph error used to still complete the video). Recovery is retry-forward only — shared/canonical nodes are never rolled back, because re-sync is idempotent and other videos/mentors may already reference them. Mentor answers are verified the same way inline at submission (`distillation_status` stamped on the answer row); `POST /interview/answers/:id/redistill` re-runs it. Failures surface on the admin Graph Health dashboard only (no email/alerting)
- Jack always searches the internal library (pgvector RAG) before answering — `usedInternalKnowledge` flag in responses
- Red Seal competency codes are seeded from a canonical list and mapped by GPT-4o during analysis
- Interview Mode reuses the video distillation + graph pipeline: mentor answers are distilled into the SAME canonical concept nodes (provenance is edge-owned via `mentor:<uuid>` → concept edges, deduped by answer id) with `verification_status="mentor_supplied"`, so mentor input corroborates rather than fragments the graph. Interview trade labels are normalized to the seeded Red Seal trades (e.g. "Welding" → "Welder") so mentor concepts hang off existing topic hubs
- Video-distilled concepts use the SAME duplicate-smart signals as mentor ingestion before minting a node: exact deterministic id → cross-category label+alias index (so a wording a mentor taught as an alias collapses a re-upload onto the same node) → same-category semantic match ≥ 0.85. **Deliberate divergence:** there is NO queue band for videos — a middle-band (0.70–0.85) video concept CREATES a new node instead of being held in `knowledge_candidates`, because video provenance edges must exist immediately (Ask Jack citations and search reference them) and every re-sync reconciles the video's full edge set, so a queued concept would silently drop that video's knowledge until a reviewer acted. When a video wording merges onto a differently-labelled node, the wording is recorded as an alias (same dedupe + 25 cap as mentors) and the canonical node's kind/category never flips on a cross-category merge
- Mentor ingestion is reinforcement-first with a three-band decision per concept: exact id / label+alias index / semantic neighbors ≥ 0.85 → **reinforce** the existing node (mentor wording recorded as an alias, capped at 25); similarity 0.70–0.85 → **queue** as a pending row in `knowledge_candidates` (OUTSIDE the live graph, deterministic `cand:<answerId>:<itemId>` id so replays never duplicate or reset review status); below 0.70 → **create** a new node. Slang/regional wordings also search the concept category and the cross-category alias index. `GET /graph/candidates` is read-only; per-concept outcomes (reinforced/new/review) surface as chips in the Interview Mode preview
- Knowledge Review resolves queued candidates through `resolveKnowledgeCandidate` in `memory-graph.ts`: **accept** reinforces the top best-match, **merge** reinforces a reviewer-chosen concept node, **reject** records a required reason and never touches the graph. Accept/merge route through `persistMentorResolvedConcepts` — the SAME write path as ingestion-time mentor reinforcement (mentor provenance edge deduped by answerId, alias recording, aggregate recompute), so there is no parallel graph-write path. Candidate statuses are `pending/accepted/rejected/merged` (renamed from `approved`); resolution is recorded on the row (`resolved_target_id`, `resolution_reason`, `resolved_at`). Replaying the same resolution is a no-op; a conflicting re-resolution returns 409; the graph write happens BEFORE the status flip so a mid-flight failure leaves the candidate pending and the retry converges
- Knowledge Review is resilient to graph drift: a recorded best-match id is a HINT, not a guarantee — `revalidateConceptTarget` re-validates every accept/merge target inside the serialized section (live as-is → merged away: follow the survivor's `meta.mergedFrom` ledger → vanished without a trail: re-match by the candidate's own content with the SAME duplicate-smart signals as ingestion → gone: structured 409 `{code:"target_gone", bestMatches}` with fresh near matches, candidate STAYS pending). Redirected resolutions record `requested_target_id` + `redirect_reason` alongside `resolved_target_id` for audit, and replays match EITHER id so a stale client retry stays a no-op. `GET /graph/candidates` annotates stored best-matches at read time with `validity` (live/redirected/gone) + `currentNodeId`/`currentLabel`; the UI strikes through gone matches, shows "now part of X" for redirected ones, disables Accept when the top match is gone, and auto-opens the merge picker on a target_gone response
- Mentor Withdrawal (`withdrawMentor`/`removeMentorGraph` in `memory-graph.ts`) removes the PERSON, not the community's knowledge: profile, sessions, verbatim answers, and candidate attribution are erased (pending candidates deleted; resolved ones keep their audit record with mentor fields nulled), while each concept the mentor touched is re-evaluated — concepts with surviving evidence are retained with recomputed aggregates (a sole-mentor `mentor_supplied` silently falls back to `unverified`; human verified/rejected decisions and aliases stay), and mentor-only concepts are demoted OUT of the live graph into attribution-free `archived` knowledge_candidates rows (deterministic `arch:<nodeId>` id). `archived` never surfaces via the API (list enum excludes it; resolving one is a 409). Ordering: graph first, candidates second, profile row LAST — so a mid-flight failure leaves the withdrawal retryable and a replay of a completed one returns 404
- The knowledge graph is persisted in Supabase (`knowledge_nodes`/`knowledge_edges`) as a deterministic-ID mirror (core `__jack__`, `topic:<trade>`, `comp:<code>`, `video:<uuid>`) synced through the video pipeline, so re-processing/merging collapses onto the same node instead of duplicating. `GET /graph` self-heals when empty; there is **no** public rebuild endpoint (the API uses the service-role key and has no auth), and the frontend falls back to deriving the graph client-side if the persisted graph is unavailable

## Product

- **Video Library** — upload, browse, and filter training videos by trade and status
- **AI Transcription** — Whisper transcribes videos with timestamps; segments are indexed for search
- **AI Analysis** — GPT-4o generates summaries, key points, and Red Seal competency mappings
- **Semantic Search** — RAG over transcript segments with pgvector; falls back to text search if no embeddings
- **Ask Jack** — Conversational AI that searches the internal library first, answers with timestamp citations
- **Knowledge Entries** — generic, NON-video knowledge assets (written field notes, sketches, photos) with a title/description/trade/category/tags/body/images/metadata (and optional related videos/timestamps). Ask Jack retrieves them semantically alongside video transcripts and cites them (image + snippet, "Field note" badge, no clip to jump to). Proves Jack can answer from knowledge that never came from a video. Created out-of-band via a seed script (no ingestion UI); retrieval is table-driven
- **Related Videos** — Vector similarity to surface related content after watching
- **Interview Mode** — Jack conversationally interviews experienced tradespeople one plainspoken question at a time (skippable); answers are saved verbatim, distilled with the same engine as videos, and reinforce the SAME shared knowledge graph as `mentor_supplied` corroboration. An interrupted interview can be picked up later via a **Resume Interview** action that appears on that mentor's node in the Living Memory graph whenever they have an incomplete session (progress is durable server-side, so it survives refreshes/new devices)
- **Knowledge Review** — admin-gated curation of queued mentor-concept candidates: Accept (green, reinforce the suggested best match), Merge (amber, reinforce a reviewer-chosen concept), Reject (red, required reason); replay-safe, with pending/accepted/merged/rejected tabs
- **Graph Health** — admin-gated dashboard on the Review screen showing knowledge-write verification: verified/partial/failed/pending counts, retry-queue depth (videos + answers), average processing time, and a log of recent writes with per-check detail; failed mentor answers get a one-click Retry distillation. A video or mentor answer never reports success if its knowledge failed to enter the graph
- **Parking Lot** — a "Park This Thought" action in Ask Jack and Interview Mode snapshots the moment (last ≤5 messages/turns, topic, unfinished thought, timestamp, trade/category, optional reason) so a promising tangent isn't lost. Parked items appear in the Living Memory sidebar (unfiltered) and on a mentor's node detail (filtered to that mentor) with status parked/resumed/resolved; Resume restores the context and — for interview items — shows a reorientation banner when the mentor returns to Interview Mode. No dedicated page; persisted server-side and session-scoped like chat history

## Required Setup — Supabase Schema

The schema (tables, pgvector functions, seed data, and the `jack-videos` storage bucket) lives in one canonical file: `scripts/src/supabase-schema.sql`.

**Recommended — apply it automatically:**

1. Add a `SUPABASE_DB_URL` secret: the Supabase Postgres connection string from Dashboard → Project Settings → Database → Connection string. Use the **Session pooler** (or direct) URI, **not** the transaction pooler — DDL needs a session connection. Remember to fill in your database password.
2. Run `pnpm --filter @workspace/scripts run setup:supabase`.

The script is idempotent, so it is safe to re-run. If `SUPABASE_DB_URL` is not set (or the connection fails), the script prints the SQL with instructions instead of crashing.

**Manual fallback:** if you can't run the script, open `scripts/src/supabase-schema.sql` and paste its contents into Supabase Dashboard → SQL Editor. That file is the canonical schema — tables, pgvector functions, seed data, the knowledge-graph tables, and the public `jack-videos` storage bucket — and is kept in sync with the app. Do not keep a second copy of the SQL here; it only drifts.

## Gotchas

- Apply the Supabase schema before the app will work — run `pnpm --filter @workspace/scripts run setup:supabase` (with `SUPABASE_DB_URL` set) or paste the SQL manually; tables don't exist until you do
- The Supabase JS/REST client cannot run DDL — schema setup needs a direct Postgres connection (`SUPABASE_DB_URL`). `DATABASE_URL`/`PG*` point at Replit's built-in Postgres, not Supabase
- Replit is IPv4-only but Supabase's **direct** host (`db.<ref>.supabase.co`) is IPv6-only, so it fails with a cryptic `ENOTFOUND`/`EAFNOSUPPORT`. Always use the **Session pooler** URL (`postgresql://postgres.<ref>:<password>@aws-<N>-<region>.pooler.supabase.com:5432/postgres`), not the direct host or the *transaction* pooler. `setup:supabase` detects this and prints the fix
- Don't paste Supabase's `[YOUR-PASSWORD]` placeholder with the literal square brackets — strip them. `setup:supabase` warns when the password is still bracket-wrapped, and an auth failure (`28P01`) means reset the password in Dashboard → Project Settings → Database
- After any OpenAPI spec change, run `pnpm --filter @workspace/api-spec run codegen` before starting the server
- Transcription/analysis are async background jobs — poll the video `status` field (queued → uploading → uploaded → transcribing → analyzing → indexing → completed, plus `failed`/`retrying`)
- Pre-existing installs must re-run the schema setup after upgrading to the job system — the schema file carries an idempotent migration (job columns + pending→queued, ready→completed, error→failed status mapping); until it runs, writes with new statuses violate the old CHECK constraint
- The `embedding` column stores JSON-serialized float arrays (vector(1536)) — Supabase's pgvector extension must be enabled first
- Jack's RAG always searches internally first; `usedInternalKnowledge: false` in chat responses means no matching segments were found
- The knowledge graph needs the `knowledge_nodes`/`knowledge_edges` tables applied too (they are part of the canonical schema) — until then `GET /graph` returns 500 and the frontend silently falls back to a client-derived graph
- Knowledge-write verification needs the `knowledge_write_log` table + the `interview_answers.distillation_status` column applied (both in the canonical schema) — re-run `setup:supabase` after upgrading. Until then `GET /graph/health` returns 500 and the Graph Health dashboard shows a load error
- Knowledge-write verification is resilient to transient PostgREST schema-cache staleness (code `PGRST205`/"…schema cache", common right after a DDL change or a fresh connection): both the verification reads and the `knowledge_write_log` audit write retry briefly (`withSchemaCacheRetry` in `memory-graph.ts`), so a write that actually landed is never mislabelled `failed`. A genuine missing node/edge is still a real `failed`/`partial` verdict (it returns a verdict, not an exception, so it is never retried away)

## User preferences

- No auth, billing, or multi-page navigation in jack-core — single-page AI engine only
- Next.js was requested but this monorepo uses React+Vite; architecture is equivalent
- Supabase is the single source of truth for all persistence
- Optimize for shipping. Do not create additional work unless it directly supports the requested task. Favor completing fewer tasks completely over discovering many new ones. Minimize reviewer workload.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
