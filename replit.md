# Jack — AI Trade Intelligence Engine

Operating handbook and entry point for agents. Read this first (~2–3 min), then follow the links into `/docs`.

Read order for a new agent: **`VISION.md` (why + priorities) → `JACK_CONSTITUTION.md` (answer rules) → this file (how it's built) → `docs/` (deep detail).**

## Project Vision

Jack is the AI Trade Intelligence Engine inside **Torch**: a single-page, searchable video knowledge library that transcribes training videos, maps them to Red Seal competencies, and answers trade questions with timestamp citations. A mentor "Teach Jack" interview flow feeds the **same** persistent Living Memory knowledge graph, so the platform grows because people teach it — not just because videos are uploaded.

- Full mission, principles & the 30-second field-UX rule: [`VISION.md`](VISION.md)
- Jack's answering/behavior rules: [`JACK_CONSTITUTION.md`](JACK_CONSTITUTION.md)

## Current Architecture

- **Monorepo:** pnpm workspaces, Node.js 24, TypeScript 5.9. Contract-first: OpenAPI → Orval (React Query hooks + Zod).
- **Frontend:** React + Vite app (`artifacts/jack-core/`) — the signed-in engine is a single conditional-render surface; wouter routing exists only for the public landing + Clerk sign-in/up pages.
- **API:** Express 5 (`artifacts/api-server/`, port 8080).
- **Auth:** Clerk (email/password + OAuth) gates the whole app; the entire `/api` surface sits behind a server-side `requireAuth`. RBAC is email-based — the `ADMIN_EMAILS` allowlist (a secret) decides who is an admin, enforced fail-closed (401/403) on the backend via `requireAdmin`. Three tiers: PUBLIC (landing + sign-in/up + health), AUTHENTICATED (whole app incl. Teach Jack + video submission), ADMIN (Knowledge Review, analytics, exports, moderation, mentor mgmt).
- **Data:** Supabase (PostgreSQL + pgvector, 1536-dim `text-embedding-3-small`) is the single source of truth; Supabase Storage (`jack-videos` bucket).
- **AI:** OpenAI Whisper (transcription) + GPT-4o (analysis + Ask Jack) + embeddings (RAG).
- **Ingestion:** a resilient, idempotent in-process job pipeline (queued → uploading → uploaded → transcribing → analyzing → indexing → completed, with `failed`/`retrying`). Knowledge writes are **strictly verified** before a video/answer is marked done.

Deep detail: [`docs/architecture.md`](docs/architecture.md) · [`docs/knowledge-graph.md`](docs/knowledge-graph.md) · [`docs/codebase-map.md`](docs/codebase-map.md) · [`docs/product-features.md`](docs/product-features.md). Run commands + Supabase setup: [`docs/operations.md`](docs/operations.md).

## Coding Standards

- **Contract-first:** edit `lib/api-spec/openapi.yaml`, then run `pnpm --filter @workspace/api-spec run codegen`. Never hand-edit generated code (`lib/api-client-react/src/generated/`, `lib/api-zod/src/generated/`).
- **Validate all I/O with Zod** (`zod/v4`). Keep `pnpm run typecheck` green across all packages.
- **Server logging:** use `req.log` / `logger` — never `console.log`. See the `pnpm-workspace` skill for workspace & TS conventions.
- **Project constraints (user preferences):** Clerk auth + email-role RBAC now gates the app (added as a launch requirement) — the signed-in engine stays a single conditional-render surface, with routing limited to the public landing + Clerk sign-in/up pages; no billing. Supabase is the single source of truth for all persistence; Next.js was requested but this monorepo uses React+Vite (architecture is equivalent). Optimize for shipping — do only what the task needs, favor completing fewer tasks completely, and minimize reviewer workload.

## Active Priorities

Protect the **core pipeline** above all new work: upload → transcribe → embed → Ask Jack → timestamped answers → competency tags → persistent Living Memory nodes. Then, in order: Teach Jack + Knowledge Review → trust/provenance surfacing → 30-second field UX → multilingual access. Never trade idempotency or provenance for a quick win. Full ordering & standing rules: [`VISION.md`](VISION.md) §9.

## Current Sprint

- **Shipped:** Beta user-testing mode — a "Start User Test" sidebar button (and `?test=true`) opens a no-permissions-first consent modal, then records screen+mic via `MediaRecorder` behind a draggable floating indicator (elapsed timer, pause/resume, stop) and an auto-dismissing think-aloud reminder. On stop, the clip auto-uploads with session/device metadata to a private Supabase bucket via `POST /api/testing/recordings`; on upload failure it falls back to a local download so a recording is never lost. Fully modular under `artifacts/jack-core/src/{lib,components}/user-testing*` — never auto-records, never blocks the app.
- **Shipped:** Living Memory "brain" upgrades — knowledge-aware neuron firing (only populated trades fire; dormant/virgin trades idle-glow), hub sizing by knowledge buckets, a dev-only Brain Statistics panel, and an ECG heartbeat desktop fix. Backed by a new read-only `GET /knowledge/stats` endpoint (per-trade `knowledge_entries` counts).
- **Deferred (not started):** relocate the "Jack just learned…" toasts out of the graph into the sidebar. Pick up on user direction.

## Known Issues / Constraints

- Admin access is empty until the `ADMIN_EMAILS` secret is set (comma/space-separated allowlist). Fail-closed: with it unset, signed-in users can use the app but NO ONE can reach admin surfaces. Clerk keys (`CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `VITE_CLERK_PUBLISHABLE_KEY`) are auto-provisioned.
- The Supabase schema must be applied before the app works (`setup:supabase` with `SUPABASE_DB_URL`); tables don't exist until you do.
- Use the Supabase **Session pooler** URL — not the direct host (Replit is IPv4-only, direct host is IPv6-only) and not the transaction pooler (DDL needs a session connection).
- After any OpenAPI change, run codegen before starting the server.
- Pre-existing installs must re-run schema setup after upgrades (idempotent job-system + `knowledge_write_log` / `distillation_status` migrations).
- Full operational gotchas & fixes: [`docs/operations.md`](docs/operations.md).

## Documentation (`/docs`)

- [`docs/README.md`](docs/README.md) — documentation index
- [`docs/architecture.md`](docs/architecture.md) — stack + core architecture decisions (pipeline, strict knowledge-write verification)
- [`docs/knowledge-graph.md`](docs/knowledge-graph.md) — Living Memory graph, ingestion bands, Knowledge Review, Mentor Withdrawal
- [`docs/codebase-map.md`](docs/codebase-map.md) — where things live (file-by-file)
- [`docs/product-features.md`](docs/product-features.md) — product feature reference
- [`docs/operations.md`](docs/operations.md) — run commands, Supabase setup, gotchas
- [`docs/upload-scalability-design.md`](docs/upload-scalability-design.md) — upload scalability design notes (design-only)
- Related root docs: [`VISION.md`](VISION.md) · [`JACK_CONSTITUTION.md`](JACK_CONSTITUTION.md) · [`threat_model.md`](threat_model.md)
