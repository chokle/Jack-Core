# Operations

Run/operate commands, the required Supabase schema setup, and operational gotchas. See also the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm --filter @workspace/jack-core run dev` — run the frontend (port 22659)
- `pnpm --filter @workspace/scripts run setup:supabase` — apply the Supabase schema (tables, functions, seed data, storage bucket)
- `pnpm --filter @workspace/api-server run seed:knowledge` — seed the sample non-video Knowledge Entries (data-driven `ENTRIES` array across trades; uploads any images, embeds, upserts by stable ids; idempotent)
- `pnpm --filter @workspace/api-server run import:knowledge` — import Knowledge Objects (`src/scripts/import-knowledge-objects.ts`)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec

## Required Setup — Supabase Schema

The schema (tables, pgvector functions, seed data, and the `jack-videos` storage bucket) lives in one canonical file: `scripts/src/supabase-schema.sql`.

**Recommended — apply it automatically:**

1. Add a `SUPABASE_DB_URL` secret: the Supabase Postgres connection string from Dashboard → Project Settings → Database → Connection string. Use the **Session pooler** (or direct) URI, **not** the transaction pooler — DDL needs a session connection. Remember to fill in your database password.
2. Run `pnpm --filter @workspace/scripts run setup:supabase`.

The script is idempotent, so it is safe to re-run. If `SUPABASE_DB_URL` is not set (or the connection fails), the script prints the SQL with instructions instead of crashing.

**Manual fallback:** if you can't run the script, open `scripts/src/supabase-schema.sql` and paste its contents into Supabase Dashboard → SQL Editor. That file is the canonical schema — tables, pgvector functions, seed data, the knowledge-graph tables, and the public `jack-videos` storage bucket — and is kept in sync with the app. Do not keep a second copy of the SQL here; it only drifts.

## Gotchas

- Pilot feedback alerts require `RESEND_API_KEY`, `FEEDBACK_FROM_EMAIL`, `FEEDBACK_NOTIFICATION_RECIPIENTS` (currently `derek@torchlabs.ca`), and `PUBLIC_SITE_URL` in Railway. Missing or rejected provider configuration marks the alert `failed`/`retrying` without failing feedback submission or logout; inspect structured `[feedback-notification]` logs and the Review detail view.
- Re-run `setup:supabase` before enabling feedback collection so the `test_feedback` workflow/status/notification columns and RLS policies exist. Do not expose Supabase credentials to the browser; all feedback and admin reads go through authenticated API routes.
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
