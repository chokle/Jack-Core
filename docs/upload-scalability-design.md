# Upload Pipeline Scalability — Design Document

**Status:** Design only. No implementation, schema, dependency, or config changes accompany this document.
**Guiding principle:** Do not prematurely optimize. Every recommendation below is gated on an **observable trigger**. Until a trigger fires, the corresponding change should not be built. Recommendations evolve the existing stack (Node/Express, Supabase Postgres + pgvector + Storage, OpenAI) rather than introducing new infrastructure, and preserve the project constraints: no auth/billing changes, Supabase remains the single source of truth.

---

## 1. The pipeline as it actually exists today

Traced end-to-end from the code (July 2026). File references are the authoritative anchors.

### 1.1 Upload

- The UI (`artifacts/jack-core/src/components/UploadModal.tsx`) POSTs `multipart/form-data` to **`POST /api/videos/ingest`** (`artifacts/api-server/src/routes/videos.ts`). The route is admin-gated (`requireAdminSession`) and rate-limited by `aiPipelineLimiter` (10 requests / 15 min / IP, in-memory store — `lib/rate-limit.ts`).
- Multer is configured with **`memoryStorage()` and a 2 GB file cap** (`videos.ts`, the `upload` const). The entire video file is buffered in the Node process's heap before the handler runs, then streamed to Supabase Storage with the service-role key.
- A legacy **signed-URL path exists but is unused by the UI**: `POST /videos/:id/upload-url` calls `supabase.storage.createSignedUploadUrl(path)` and returns `{uploadUrl, token}`. This is the natural escape hatch for direct-to-storage uploads later (see §4.3/§4.4).

### 1.2 Background job orchestration

- After the storage upload, the route **atomically acquires a "transcription slot"** with a conditional UPDATE (`status='transcribing' WHERE transcript IS NULL AND status != 'transcribing'`). This correctly prevents duplicate concurrent jobs (Postgres row-locks the UPDATE; the loser matches zero rows).
- The job itself is a **`setImmediate` closure in the API process** (`videos.ts`, both in `/videos/ingest` and `/videos/:id/transcribe`). Consequences, all verifiable in the code:
  - **Jobs are lost on restart.** The closure lives only in process memory. Nothing re-enqueues it.
  - **Worse: a lost job wedges the video permanently.** The slot guard requires `status != 'transcribing'` to re-acquire — but a crash mid-job leaves `status='transcribing'` in the row forever. After a restart, `POST /videos/:id/transcribe` returns 202 "Transcription already in progress" indefinitely. The only recovery today is a manual `PATCH /videos/:id` to reset `status`.
  - **No retry.** Any failure (OpenAI 429/5xx, ffmpeg exit, Supabase write error) is caught once, sets `status='error'`, and stops. There is no backoff or re-attempt anywhere in the pipeline.
  - **Jobs compete with request handling.** All JS work (JSON serialization of 1536-dim embeddings, Supabase round-trips, response parsing) runs on the same event loop that serves `/videos`, `/chat`, and `/search`. ffmpeg/ffprobe are separate OS processes (`spawn` in `lib/transcription.ts`) so they don't block the loop, but they compete for the same container CPU.
- Stage chaining is sequential inside one closure: transcribe → embed segments → insert segments → embed full transcript → analyze (GPT) → graph sync → distillation → graph knowledge sync. A failure in analysis is deliberately non-fatal (transcript survives, `runAnalysis` fallback), and graph sync/distillation are best-effort (`syncGraphSafe` / `distillGraphSafe` log and continue).

### 1.3 Media handling (`lib/transcription.ts`)

- `transcribeFromUrl`:
  1. HEAD request rejects sources whose `Content-Length` exceeds **`MAX_SOURCE_VIDEO_BYTES` = 500 MB** (servers omitting Content-Length are bounded only by disk at download time).
  2. Downloads the **full video to `/tmp`** (streamed to disk, not RAM).
  3. ffmpeg extracts mono 16 kHz 64 kbps AAC audio (~28 MB/hour of audio).
  4. If the audio is ≤ 24 MB (`SINGLE_PASS_MAX_BYTES`, under Whisper's 25 MB upload cap), one Whisper call. Otherwise it is split into **time-based chunks targeting 20 MB each, capped at `MAX_WHISPER_CHUNKS` = 10**, and each chunk is transcribed **sequentially** in a for-loop. At 64 kbps, 20 MB ≈ 43 min of audio, so the cap bounds one job at ~7 hours of audio and ≤ 10 Whisper calls. Content beyond the cap is silently dropped (`start >= duration` break governs the other direction; the chunk-count cap truncates very long audio).
  5. Temp files are removed in a `finally`.
- Peak **disk** per job: source video + extracted audio + one chunk. Note the 500 MB cap is enforced **only when the source responds to HEAD with a Content-Length** — a server omitting it can stream an arbitrarily large file to `/tmp` (in practice sources are Supabase Storage public URLs, which do send Content-Length, but the cap is not a hard disk guarantee). Peak **RAM** for transcription is small (streams + spawn), but recall §1.1: the *upload* path holds up to 2 GB in heap per in-flight request.

### 1.4 Embeddings and persistence

- Segment embeddings: `createEmbeddings` (`lib/openai.ts`) batches 96 inputs per OpenAI call, batches issued sequentially. Segment rows are inserted in batches of 100, sequentially — each row carries a JSON-serialized 1536-dim vector (~19 KB of JSON per row).
- Whole-video embedding: first 8,000 chars of the transcript. Cache behavior is **mixed today**: the `/videos/:id/transcribe` path passes `{cache: false}` (correct — one-time large input), but the `/videos/ingest` path calls `createEmbedding` with the default cache enabled, so full-transcript prefixes can occupy slots in the 1,000-entry query cache. Harmless at any scale (bounded cache), just an inconsistency worth knowing when reading cache-hit behavior.
- A per-process in-memory embedding cache (1,000 entries, FIFO-ish eviction) dedupes repeated *query* embeddings only; it does not affect ingestion cost.

### 1.5 Analysis and distillation

- `runAnalysis` (`routes/videos.ts`): one `gpt-4o-mini` call over the first 6,000 chars of the transcript + the **entire competencies table** (fetched fresh each run) as prompt context.
- `runDistillation` (`lib/distillation.ts`): one `gpt-4o-mini` call over ≤ 8,000 chars of timestamped transcript, bounded to ≤ 12 concepts (`MAX_KNOWLEDGE_ITEMS`).

### 1.6 Graph sync (`lib/memory-graph.ts`)

- `syncVideoGraph` upserts nodes then reconciles the video's structural edges via **delete-then-reinsert** (two scoped deletes + upsert). `pruneOrphanTopics` and `pruneOrphanKnowledge` each load **entire tables/kind-slices into Node memory** (all topics, all knowledge-kind nodes, all `kind='knowledge'` edges) to compute orphans.
- Distillation's canonical-ID resolution calls `buildKnowledgeAliasIndex()`, which does a **full scan of every knowledge-kind node (`select id, kind, label, meta`) per sync**, building the label+alias map in process memory. This runs on every video distillation and every mentor answer.
- Semantic dedup uses the `match_knowledge_nodes` RPC — a **sequential scan** over `knowledge_nodes.embedding` (no ANN index exists; see §1.7).

### 1.7 Indexes (from `scripts/src/supabase-schema.sql`)

- B-tree indexes exist on `videos(status)`, `videos(trade)`, `transcript_segments(video_id)`, `chat_messages(session_id)`, the `knowledge_*` id/kind/source/target columns.
- **There are no pgvector ANN indexes (no HNSW, no IVFFlat) on any embedding column.** `match_transcript_segments`, `match_videos`, and `match_knowledge_nodes` all do exact sequential scans with cosine distance. This is exact (perfect recall) and fine at small scale — and it is the clearest data-driven cliff in the system (see §2.4).

### 1.8 Other single-process state

- Rate limiters (`lib/rate-limit.ts`) use express-rate-limit's default in-memory store — per-process, reset on restart. Irrelevant until there are multiple API processes (§5, 10k tier).
- `GET /videos/stats` selects **every video row** and aggregates in JS — a linear cost that grows with library size on a public, unthrottled endpoint.

---

## 2. Bottleneck analysis — where it actually breaks, and when

Scale below is expressed in videos, assuming a rough median of ~15 min/video and ~150 transcript segments/video (Whisper emits a segment roughly every 5–10 s of speech). Adjust proportionally if real videos skew long.

### 2.1 Upload memory (the earliest cliff — concurrency-based, not library-size-based)

`multer.memoryStorage()` with a 2 GB cap means **each in-flight upload can hold up to 2 GB of heap**. Two concurrent 1.5 GB uploads exceed the memory of most small containers and OOM-kill the process — which, per §1.2, also wedges any video mid-transcription at the time. This breaks at *concurrent-upload count ≈ 2*, independent of library size. It is admin-gated and rate-limited (10/15 min), so exposure is low today with a single trusted uploader — but it is the first real limit.

### 2.2 In-process jobs (breaks on restarts and failure rates, not raw scale)

At any scale, a deploy/restart during a job silently wedges that video (mechanism in §1.2). At 1–2 uploads/day this is a rare manual fix; at dozens/day (≈ the 1,000-video tier if reached within months) restarts will routinely strand videos and the lack of retry turns every transient OpenAI 429/5xx into a terminal `error` status. The failure is *operational frequency*, not throughput.

### 2.3 Whisper limits and sequential transcription

- Hard: 25 MB/upload (already handled by chunking), 10-chunk cap silently truncates audio > ~7 h (acceptable; training clips).
- Rate: whisper-1 is limited to roughly 50–500 RPM depending on account tier. One video ≤ 10 sequential calls — irrelevant until many videos process concurrently (10k tier with parallel workers). Sequential chunking makes a 3-hour video take ~4–5 sequential Whisper round-trips; wall-clock per video is minutes, dominated by download + ffmpeg + Whisper latency. Fine while jobs are rare and serial.
- Cost anchor: Whisper ≈ $0.006/min → ~$0.09 per 15-min video; embeddings ≈ $0.02/1M tokens → well under a cent per video; two gpt-4o-mini calls → fractions of a cent. **≈ $0.10/video total.** OpenAI spend is not a scaling constraint until ~100k videos (~$10k cumulative), and even then it is linear, not a cliff.

### 2.4 pgvector sequential scans (the main *library-size* cliff)

`transcript_segments` grows ~150 rows/video. Every `/search` and every Ask Jack turn scans all segment rows with non-null embeddings (related-videos scans the much smaller `videos.embedding` column — one row per video — so it degrades ~150× later):

| Videos | Segment rows | Vector data scanned | Expected exact-scan latency* |
|---|---|---|---|
| 100 | ~15k | ~90 MB | tens of ms — fine |
| 1,000 | ~150k | ~900 MB | hundreds of ms — visible p95 degradation, memory-bound |
| 10,000 | ~1.5M | ~9 GB | seconds; won't fit shared_buffers on small Supabase plans |
| 100,000 | ~15M | ~90 GB | unusable without ANN + capacity planning |

\* 1536-dim float4 ≈ 6 KB/row; exact scan is memory-bandwidth-bound when hot, disk-bound when not.

The knee is between 100 and 1,000 videos. This is the first place users *feel* scale, and it is fixable with a single `CREATE INDEX` (§5, 1k tier) — no architecture change.

### 2.5 Graph-sync full scans

`buildKnowledgeAliasIndex` scans all knowledge-kind nodes per sync. Knowledge nodes grow sub-linearly (≤ 12/video with heavy dedup — realistically a few per video after collapsing). At 1,000 videos that's likely 2–5k nodes ≈ a few MB per scan — noticeable but harmless. At 10k–100k videos (tens to hundreds of thousands of nodes with `meta` JSONB), a multi-hundred-MB fetch per ingested video becomes the slowest sync stage and a real memory spike. Same shape applies to `pruneOrphanKnowledge` (all knowledge nodes + all knowledge edges per prune). Breaks meaningfully at the 10k tier; worth an incremental design at 1k only if sync-duration logs show it (trigger-gated, §5).

### 2.6 Storage growth

Originals are kept forever in the public `jack-videos` bucket. At ~300 MB/video average: 100 videos ≈ 30 GB, 1k ≈ 300 GB, 10k ≈ 3 TB, 100k ≈ 30 TB. Supabase storage is ~$0.021/GB-month → ~$6/mo at 100 videos, ~$63/mo at 1k, ~$630/mo at 10k. Pure cost, no cliff — a lifecycle *decision* (keep originals for playback vs. keep only extracted audio) belongs at the 10k tier when the bill is material (§4.8).

### 2.7 Misc linear costs

`GET /videos/stats` (full-table fetch, public) and `GET /videos/:id` (joins *all* segments for a video) are linear but small; stats becomes the first *public-endpoint* full scan to matter around the 10k tier.

---

## 3. Metrics to monitor — with today's tooling only

The API already logs structured JSON via pino (`pino-http` per-request lines with latency; `logger`/`req.log` events). Everything below is observable **now** from existing logs plus the Supabase dashboard — no new infrastructure.

| Signal | Where to see it today | Tier boundary it warns about |
|---|---|---|
| Per-stage job latency | Timestamps between existing log lines per `videoId`: slot-acquired (202 response log) → `"transcribe: chunking large audio"` (only for chunked jobs) → `"distilled atomic knowledge"` / `"Analysis failed"` / `"Transcription failed"`. A single `stage`+`durationMs` log line per stage would be a trivial, worthwhile addition *when needed* — but stage boundaries are already reconstructable. | In-process job saturation (§2.2) |
| Concurrent-job count / queue depth | `SELECT status, count(*) FROM videos GROUP BY status` — rows in `transcribing`/`analyzing` *are* the queue. Also exposed by public `GET /videos/stats` (`byStatus`). | > 2–3 concurrently `transcribing` sustained → jobs are backing up; > 0 stuck for > 1 h → wedged job (restart happened) |
| Wedged-job count | Same query filtered by `updated_at` age (note: background stages don't touch `updated_at`, so use log absence + status age). | Any recurrence → durable job state (1k tier) is due |
| OpenAI 429/5xx rate | pino error logs: `"Transcription failed"`, `"Analysis failed"`, `"atomic knowledge distillation failed"` include the `err` object with OpenAI status codes. | Sustained 429s → retry/backoff (1k tier), then worker-level rate budgeting (10k) |
| p95 `/search` and `/chat` latency | pino-http `responseTime` per request line — filter by route. | > ~500 ms p95 on search → pgvector ANN index (1k tier) |
| Embedding-table row counts | Supabase dashboard / `SELECT count(*) FROM transcript_segments` | > ~100k rows → ANN index due even if p95 hasn't degraded yet |
| Graph sync duration | Reconstructable from log-line spacing around `"distilled atomic knowledge"`; add a duration field when it exceeds a few seconds. | > ~5 s per sync → alias-index incremental maintenance (§4.9) |
| Storage growth | Supabase dashboard → Storage usage. | Bill materiality → lifecycle policy (10k tier) |
| Upload memory pressure | Container memory metrics (Replit/deployment dashboard); OOM restarts in workflow logs. | Any OOM correlated with uploads → streaming upload fix (§4.3) — this may fire *before* any video-count tier |

**The operating rule:** check `byStatus` counts and p95 search latency roughly weekly (or after any burst of uploads). Do not build anything in §5 until its trigger column fires.

---

## 4. The nine consideration areas

Each area: what exists today, what would change, and the tier (or "never") where it becomes justified.

### 4.1 Background workers
Today: `setImmediate` closures in the API process. **Not needed until the 10k tier** as a *separate process* — but the *durability* half of the problem (jobs lost + videos wedged on restart) is cheap to fix inside the current architecture at the 1k tier: persist job intent in Postgres (the `videos.status` column already is a crude job table; add `processing_started_at` + a startup sweep that resets stale `transcribing`/`analyzing` rows older than a timeout back to a retryable state). That keeps one process, no new infra, and eliminates the permanent-wedge failure mode. A true separate worker process (same codebase, second workflow, polls for claimable rows) is the 10k-tier version.

### 4.2 Queueing
Today: none — the atomic UPDATE slot is a binary mutex per video, and concurrency is bounded only by the rate limiter. **1k tier — no queue *system*:** the videos table itself acts as the queue (claim via the same conditional-UPDATE pattern, which is already correct compare-and-set semantics; add `attempts` and `next_attempt_at` columns). This is the durable-job-state item from §4.1/§4.7 wearing a different hat, not new infrastructure. **10k tier:** adopt `pg-boss` (Postgres-backed job queue — runs *on Supabase*, honoring the single-source-of-truth constraint; no Redis, no SQS) when you need multiple named queues (transcribe/embed/analyze as separate stages), per-queue concurrency, and cross-process claiming with heartbeats. Do not introduce a non-Postgres queue at any tier — nothing in this workload needs sub-second dispatch latency.

### 4.3 Chunked uploads
Today: single multipart POST, fully buffered in RAM (§2.1). The fix is not tied to a video-count tier — **trigger: any upload-correlated OOM, or the day more than one person uploads concurrently.** Cheapest evolution first: switch multer to disk storage (`/tmp`) and stream the file to Supabase Storage — removes the 2 GB heap exposure with ~10 lines changed, keeping the server-mediated flow and admin gating. True chunked/parallel-part upload only matters with the direct-to-storage flow below.

### 4.4 Resumable uploads
Today: none — a dropped connection at 1.9 GB restarts from zero. Supabase Storage natively supports **TUS resumable uploads**, and the codebase already contains the unused signed-URL route (`POST /videos/:id/upload-url`) as the seam for a direct-to-storage flow (browser uploads to Supabase with a scoped token; server never proxies bytes). **10k tier, or earlier only if real users on unreliable connections report failed large uploads.** Not worth it while the uploader population is one admin on a stable connection: the added client complexity (tus-js-client, progress/resume state) and the storage-side finalize/verify webhook flow outweigh the benefit.

### 4.5 Parallel transcription
Today: chunks transcribed sequentially in a for-loop (`transcribeFromUrl`). Parallelizing chunk calls (e.g. `Promise.all` over ≤ 10 chunks, or a small concurrency pool of 3–4) is a one-function change that cuts long-video wall-clock ~3–5×. **But: not needed until videos > ~50 min are common AND per-video latency is a complaint** — at the current scale a video is "ready" in minutes and nobody is waiting on it synchronously. Earliest honest tier: 10k (where worker throughput matters), or on user complaint. Caution: parallel chunks × parallel videos multiplies Whisper RPM consumption — pair with the rate-budget design at 10k.

### 4.6 Embedding workers
Today: segment embedding is already batched (96/call) and is not a measured bottleneck — a 150-segment video is 2 API calls. A dedicated embedding worker only makes sense when embedding is decoupled from transcription as a separate queue stage (10k tier), primarily to (a) survive partial failures without redoing Whisper, and (b) enable **backfills** (e.g. re-embedding the corpus after a model upgrade — the only realistic scenario where embedding throughput dominates). **Not worth building until a re-embed of > ~1k videos is actually planned or the 10k queue split happens.**

### 4.7 Retry strategies
Today: none (single try, terminal `error`). **1k tier**, alongside durable job state: per-stage retry with exponential backoff + jitter for retryable failures (OpenAI 429/5xx/timeouts, Supabase transient errors), bounded attempts (e.g. 3), non-retryable failures (ffmpeg exit on corrupt media, 400s) go straight to `error`. Critically, the pipeline's stage guards already make retries *safe*: transcription re-runs are idempotent (segments delete-then-insert, transcript overwrite), analysis/distillation/graph sync are idempotent by deterministic IDs — so retry is purely additive, no dedup work needed. This is the highest value-per-effort item in the whole document.

### 4.8 Storage lifecycle
Today: originals kept forever, public bucket; extracted audio is temp-only (deleted after transcription). Decision point at the **10k tier** (~$600+/mo): options in order of preference — (a) keep originals (they power playback in `VideoDetail`; deleting them changes the product), (b) transcode originals to a lower-bitrate playback rendition and drop the source, (c) persist the 64 kbps audio (~3% of video size) as the retranscription asset and archive originals. Until playback requirements change or the bill is material, **do nothing** — deleting user-visible assets to save tens of dollars is a bad trade.

### 4.9 Indexing performance
Today: no ANN indexes; exact scans everywhere (§1.7, §2.4).
- **1k tier (trigger: p95 search > ~500 ms or segment rows > ~100k):** add **HNSW** on `transcript_segments.embedding` (`vector_cosine_ops`), and later `videos.embedding` + `knowledge_nodes.embedding` if their scans show up. HNSW vs IVFFlat: HNSW has slower builds and more memory but no training step, no `lists` tuning, better recall at low latency, and — decisive here — **IVFFlat requires representative data at index-build time and degrades as the distribution shifts**, while HNSW handles incremental insert-heavy workloads (exactly this pipeline) gracefully. IVFFlat's only advantage (build speed/size) matters at the 100k tier, where a periodic rebuild schedule could make it viable; until then HNSW is the default.
- Recall caveat: ANN is approximate. `match_transcript_segments` semantics stay identical (the function body doesn't change; the planner uses the index), but citation recall should be spot-checked after the index lands.
- **1k–10k:** alias-index incremental maintenance (§2.5) — replace the per-sync full node scan with a targeted query: the alias index only needs candidates matching the ≤ 12 normalized titles in the current batch, which a `WHERE label-norm IN (...)` lookup (or a small `aliases` side table with a unique normalized-form column) answers without scanning the world. Trigger: sync duration > ~5 s or knowledge-node count > ~20k.
- **100k tier:** partition `transcript_segments` by trade or time, per-partition HNSW, and revisit whether whole-corpus search should filter by trade *before* vector search (the RPC already supports `filter_trade` — pushing it into a partial-index strategy is the 100k-scale lever).

---

## 5. Staged scaling plan

Every item is gated by its trigger. **If the trigger hasn't been observed, do not build the item.**

### Tier: ~100 videos — build nothing

The current design holds, and here is why: exact vector scans over ~15k segment rows are tens of ms; one admin uploader means job concurrency is ~1 and the in-process job model's restart risk is a rare, manually recoverable annoyance; OpenAI spend is ~$10 cumulative; storage ~$6/mo. Sequential everything is fine because nothing is waiting.

**The only watch item that can fire before this tier ends:** upload OOM (§2.1/§4.3) — it is concurrency-triggered, not scale-triggered. If an OOM happens, do the multer disk-storage + streaming fix immediately; it is small and safe at any tier.

### Tier: ~1,000 videos

| Change | Trigger — do not build until observed |
|---|---|
| Durable job state + startup sweep for wedged rows (§4.1) | ≥ 2 videos found wedged in `transcribing`/`analyzing` after restarts, or restarts become routine (frequent deploys) |
| Per-stage retry with backoff (§4.7) | Recurring terminal `error` statuses whose logs show 429/5xx/timeout (i.e., transient) causes |
| HNSW index on `transcript_segments.embedding` (§4.9) | p95 `/search` or `/chat` responseTime > ~500 ms, or segment rows > ~100k |
| Multer disk storage + streamed storage upload (§4.3) | Any upload-correlated OOM, or a second regular uploader exists |
| Alias-index incremental lookup (§4.9) | Graph sync duration > ~5 s per video, or knowledge nodes > ~20k |

Explicitly **not** at this tier: separate worker processes, a dedicated queue system (pg-boss or otherwise — the durable-job-state columns above are the whole "queue" at 1k), parallel transcription, resumable uploads, storage lifecycle — none of their triggers can fire at this scale with one uploader.

### Tier: ~10,000 videos

| Change | Trigger |
|---|---|
| pg-boss (Postgres-backed) queue + separate worker process(es), stages split into transcribe/embed/analyze queues (§4.1/§4.2/§4.6) | Sustained queue depth (videos in `transcribing`/`analyzing`) > ~5, or ingestion latency SLO misses, or API p95 degrades during ingestion bursts (event-loop contention observed in pino responseTime) |
| Parallel chunk transcription with a small concurrency pool + per-worker OpenAI rate budget (§4.5) | Long videos common AND per-video ready-time complaints; watch Whisper 429s in logs |
| Direct-to-storage resumable (TUS) uploads via the existing signed-URL seam (§4.4) | Upload failure reports from real users on large files, or server bandwidth cost of proxying uploads becomes visible |
| Storage lifecycle decision (§4.8) | Storage bill material (> ~$300–600/mo) — prefer keeping originals unless playback needs change |
| HNSW on `videos.embedding` and `knowledge_nodes.embedding` | Their scan latency visible in related-videos / distillation timing |
| Shared rate-limit store (Postgres-backed) | Only when a second API process exists (limits are per-process today) |
| `GET /videos/stats` aggregate moved into SQL | Endpoint latency visible in pino responseTime |

### Tier: ~100,000 videos

| Change | Trigger |
|---|---|
| Horizontal workers (N processes, pg-boss handles claiming/heartbeats) with global OpenAI quota budgeting and backpressure (pause claiming when 429 rate rises) | Single worker saturated: queue depth grows despite healthy worker |
| Dedicated vector index strategy: `transcript_segments` partitioned (by trade), per-partition HNSW, evaluate IVFFlat with scheduled rebuilds for the coldest partitions; capacity-plan Supabase compute for index memory (~15M rows ≈ 90 GB of vectors — index memory becomes the dominant sizing input) | p95 search misses SLO *with* HNSW, or index build/maintenance times disrupt ingestion |
| Ingestion admission control: per-day upload quotas, explicit queue-full responses instead of unbounded acceptance | Queue depth growth is demand-driven, not capacity-driven |
| Knowledge-graph prune/aggregate jobs moved to scheduled SQL (set-based, in-database) instead of load-all-into-Node (§2.5) | Prune duration or memory spikes visible per sync |
| Consider Supabase read replicas for search/chat read paths | Read QPS contends with ingestion writes on primary |

Even at this tier, the stack remains Node + Supabase + OpenAI; the only new dependency introduced anywhere in this plan is pg-boss (which stores its state in the same Postgres). No Redis, no Kafka, no separate vector DB — the workload (ingest-heavy, moderate read QPS, exact provenance requirements) does not justify them, and a separate vector store would break the single-source-of-truth constraint for embeddings.

---

## 6. What this document deliberately does not recommend

- **A vector database (Pinecone/Weaviate/etc.)** — pgvector with HNSW comfortably serves this corpus through 100k videos on adequately sized Supabase compute, and moving embeddings out of Postgres forfeits transactional consistency with `transcript_segments` rows and violates the Supabase-as-source-of-truth constraint.
- **Kubernetes/serverless media processing** — ffmpeg-in-worker on plain processes is sufficient; the 500 MB source cap and 64 kbps audio extraction keep per-job resources small and predictable.
- **Changing ingestion decision rules** — the three-band mentor logic and the video middle-band create policy are product decisions, out of scope, and nothing in scaling requires touching them.
- **Speculative observability infrastructure** — pino logs + Supabase dashboard cover every trigger in §3. Add a metrics stack only if log-based checks become an operational burden (a people-cost trigger, not a scale one).
