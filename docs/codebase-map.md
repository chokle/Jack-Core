# Codebase Map — Where Things Live

File-by-file map of the API server and frontend. Contract source of truth is `lib/api-spec/openapi.yaml`; generated clients/schemas are never edited by hand.

## Session & Parking Lot

- `artifacts/api-server/src/lib/session.ts` — shared HttpOnly `jack_session` cookie helpers (`resolveSession`/`readSession`/`SESSION_COOKIE`/`COOKIE_OPTS`), extracted so `chat.ts` and `parking-lot.ts` share one session-scoping implementation
- `artifacts/api-server/src/routes/parking-lot.ts` — Parking Lot endpoints: `POST /parking-lot` (park), `GET /parking-lot` (list, filterable by `status`/`mentorProfileId`), `POST /parking-lot/:id/resume`, `POST /parking-lot/:id/archive`. Rate-limited (`parkingLotLimiter`, 30/15min)
- `artifacts/jack-core/src/components/ParkedThoughts.tsx` — shared Parking Lot UI: `ParkThisThoughtButton` (the "Park This Thought" popover, used from Ask Jack and Interview Mode) and `ParkedThoughtsList` (the list card — used unfiltered in the Living Memory sidebar and filtered by `mentorProfileId` in a mentor node's detail panel). Also owns the one-shot `jack.interview.resumeNote` localStorage handoff that carries a parked interview thought's reason/unfinished-thought into Interview Mode's reorientation banner

## API contracts & generated code

- `lib/api-spec/openapi.yaml` — single source of truth for all API contracts
- `lib/api-client-react/src/generated/` — generated React Query hooks (don't edit)
- `lib/api-zod/src/generated/` — generated Zod schemas (don't edit)

## Frontend & API roots

- `artifacts/jack-core/src/` — React frontend (Library, VideoDetail, AskJack, UploadModal)
- `artifacts/api-server/src/routes/` — Express route handlers (videos, search, chat, competencies)
- `artifacts/api-server/src/lib/supabase.ts` — Supabase client
- `artifacts/api-server/src/lib/openai.ts` — OpenAI client

## Knowledge Entries (non-video assets)

- `knowledge_entries` (table + `match_knowledge_entries` RPC in `scripts/src/supabase-schema.sql`) — generic, NON-video knowledge assets (written field notes, sketches, photos). Retrieval is table-driven, not hardcoded. `chat.ts` searches it with the SAME query embedding as transcripts and merges hits into Ask Jack's context + citations; `artifacts/api-server/src/scripts/seed-knowledge-entry.ts` is the (data-driven) manual create path — there is no ingestion UI
- `artifacts/api-server/src/lib/knowledge-schema.ts` — the Knowledge Object richer-metadata schema (Phase 1): `KnowledgeObjectMeta` type (all fields OPTIONAL, stored inside the existing `knowledge_entries.metadata` JSONB — no migration), the `KNOWLEDGE_OBJECT_FIELDS` key list, and `readKnowledgeMeta()` (graceful, non-lossy reader). `trade`/`tags` are already first-class columns so they are NOT re-declared here. Retrieval is untouched (`match_knowledge_entries` still doesn't return metadata); this only defines the shape the seed/store path uses. Wired into `seed-knowledge-entry.ts`'s `Entry.metadata` type
- `artifacts/api-server/src/routes/knowledge.ts` — `GET /knowledge/stats` (per-trade `knowledge_entries` counts; read-only, no DB writes). Feeds Living Memory hub sizing / knowledge-aware neuron firing and the dev-only Brain Statistics panel

## Jobs & video status

- `artifacts/api-server/src/lib/jobs.ts` — resilient job system (stage claiming, pipeline driver, retry/backoff, startup recovery sweep + watchdog)
- `artifacts/jack-core/src/lib/video-status.ts` — shared client-side IN_FLIGHT_STATUSES set (drives polling + UI states)

## Living Memory canvas & spatial navigator

- `artifacts/jack-core/src/lib/graph-perf.ts` — pure, unit-tested perf-path geometry for the Living Memory canvas (spatial-grid repulsion threshold + cell math, padded viewport cull bounds, glow/topic LOD thresholds); `MemoryGraphCanvas` imports these so drawn and tested behavior can't drift
- `artifacts/jack-core/src/lib/graph-stress.ts` — `buildSyntheticServerGraph(n)`: synthetic large graph for exercising the canvas large-graph paths; used by the dev-only `?graphStress=N` toggle (in `use-memory-graph.ts`, DEV-gated, capped 5000) and by `graph-perf.test.ts`
- `artifacts/jack-core/src/lib/graph-spatial.ts` — pure, unit-tested 2.5D spatial geometry for the Living Memory navigator (no three.js): `MAJOR_TRADES` (the 12 major Red Seal trades), `withSeededTrades(model)` (injects the 12 trade hubs into the DISPLAYED model — first 5 reuse the exact seeded labels so `topic:<label>` ids collapse onto existing hubs; the rest render as empty "virgin" clusters — then re-runs `finalizeModel`), `buildAdjacency`/`buildHierarchy`, `fibonacciSphereDir`, `buildSpatialLayout` (shell radii by hop distance), `rotatePoint`/`projectPoint` (perspective, FOCAL=820/CAMERA_DISTANCE=620), `clampPitch` (±60°), `depthCue`, plus the perf caps (`DEFAULT_MAX_HOPS`, `DEFAULT_MAX_VISIBLE`). Also exports `topicRadiusWeight(contentCount)` (knowledge-bucket hub sizing: 0 dormant / 1–5 / 6–15 / 16–40 / 40+) and `computeBrainStats(model)` (read-only aggregates for the dev Brain Statistics panel). Imported by `SpatialBrainCanvas` so drawn and tested behavior can't drift
- `artifacts/jack-core/src/components/SpatialBrainCanvas.tsx` — the 2.5D spatial navigator; a drop-in contract sibling of `MemoryGraphCanvas` (identical `MemoryGraphHandle` + props) that renders the graph on an orbit camera (`{yaw,pitch,zoom}`): pointer-drag orbit, 2-pointer pinch + wheel zoom, double-click pin, click-to-lock recentering (selecting a node recenters on it; empty space recenters on the JACK core). Depth-sorted draw with virgin trade hubs shown as a dashed ring + "+ be the first". Knowledge-aware firing: only populated hubs fire; dormant/virgin trades get a faint idle glow; a trade's first contribution triggers a one-time activation burst (gated on `dataReady` so a fresh load only seeds the baseline). `MemoryGraphView` renders this instead of `MemoryGraphCanvas` (which is left untouched for rollback safety) and applies `withSeededTrades` ONCE via `useMemo` (the delta stream stays derived from the RAW model, so a freshly-seeded empty trade never fires a "Jack just learned…" toast); a virgin trade's node detail shows a "Be the first — teach Jack" CTA that opens Interview Mode

> **Deprecated / legacy (retained for rollback):** `MemoryGraphCanvas` (the flat 2D canvas) is superseded by `SpatialBrainCanvas` and is no longer rendered by `MemoryGraphView`, but is intentionally kept for rollback safety. `graph-perf.ts` supports that legacy canvas; the active navigator uses `graph-spatial.ts`.

## Systems Health / vitality

- `artifacts/api-server/src/lib/vitality-score.ts` — pure, typed vitality scoring: `VitalityState`/`PulseColor`/`VitalityStatus` types, `VitalitySignals`/`VitalitySnapshot` shapes, thresholds (`ERROR_ACTIVE_MS`, `SEARCH_ACTIVE_MS`, `WRITE_RECENT_MS`, `BPM_BANDS`), and `deriveState()` — so scored behavior is unit-testable and can't drift from the widget
- `artifacts/api-server/src/lib/vitality.ts` — in-process vitality event bus: `publish`/`subscribe`, `readSignals`/`readSnapshot`, the `trackInference`/`trackMemoryWrite`/`trackJob` wrappers that instrument the pipeline, and `startVitalitySampler(intervalMs)`
- `artifacts/api-server/src/routes/system-health.ts` — `GET /system-health` (current vitality snapshot for the heartbeat widget)
- `artifacts/jack-core/src/components/SystemHealthWidget.tsx` — the ECG "heartbeat" widget (canvas-drawn traveling pulse; guarded ResizeObserver so it re-measures on mount)

## Supabase & knowledge graph (server)

- `scripts/src/setup-supabase.ts` — Supabase schema setup script/reference
- `artifacts/api-server/src/lib/memory-graph.ts` — knowledge-graph persistence (node/edge sync, self-heal, rebuild)
- `artifacts/api-server/src/routes/graph.ts` — `GET /graph` (persisted Living Memory graph); also serves `GET /graph/candidates` (queued mentor-concept candidates, filterable by status; `pending` reads are public, non-pending statuses carry resolution details and require the admin session), `POST /graph/candidates/:id/resolve` (admin-gated Knowledge Review: accept/merge/reject), and the admin-gated `GET /graph/health` (Graph Health: knowledge-write verified/partial/failed/pending counts, retry-queue depth, avg processing time, recent-write log with per-check detail)

## Interview Mode & Review UI

- `artifacts/api-server/src/routes/interview.ts` — Interview Mode endpoints (start session, get, submit/skip answer, finish), the public `GET /interview/mentors/:id/active-session` (a mentor's in-progress/incomplete interview — powers "Resume Interview" on their Living Memory node), plus the admin-gated `GET /interview/mentors` (mentor roster with session/answer counts), `POST /interview/mentors/:id/withdraw` (Mentor Withdrawal), and the admin-gated `POST /interview/answers/:id/redistill` (re-run distillation + knowledge-write verification for one answer). Answer submission distills + verifies inline and stamps `distillation_status` on the answer row
- `artifacts/api-server/src/lib/interview.ts` — interview trades/categories + next-question engine (GPT-4o with deterministic fallback)
- `artifacts/jack-core/src/components/InterviewMode.tsx` — Interview Mode UI (intake → conversation → completion)
- `artifacts/jack-core/src/components/MentorWithdrawal.tsx` — admin-only mentor roster on the Review screen with a confirm-guarded destructive Withdraw action; surfaces the retained/archived/deleted/scrubbed summary after withdrawal
- `artifacts/jack-core/src/components/KnowledgeReview.tsx` — Knowledge Review UI (admin-gated candidate curation: Accept / Merge into… / Reject with reason)
- `artifacts/jack-core/src/components/GraphHealth.tsx` — admin-only Graph Health dashboard on the Review screen; summary counts, retry queue, recent-write log with per-check pills, and a one-click Retry distillation on failed mentor answers
- `artifacts/jack-core/src/components/PendingKnowledgePanel.tsx` — read-only "Awaiting Knowledge Review" panel in the Living Memory right rail (public: title, category, mentor, near-matches; no resolution controls)
- `artifacts/jack-core/src/lib/memory-graph.ts` — client graph model (`buildGraphModelFromServer` + client-derived fallback)
