---
name: PostgREST schema-cache transience
description: Why supabase-js calls can briefly fail with PGRST205/"schema cache" after DDL, and how to distinguish that from a real failure.
---

PostgREST keeps an in-memory schema cache. Right after a DDL change (new table/column) or on a fresh connection, a call to a table/column that DOES exist can fail with code `PGRST205` ("Could not find the table '…' in the schema cache"), the column variant `PGRST204`, or `PGRST202`. It is transient — the cache reloads within moments.

**The rule:** any supabase-js operation whose failure would flip a user-visible verdict must treat these codes distinctly and retry through the reload window (short backoff, a few attempts). Do NOT treat them as a permanent failure.

**Why:** in Jack, knowledge-write verification stamped a mentor answer `distillation_status="failed"` (and surfaced it on Graph Health) even though its concept nodes had actually landed — the false negative came from a transient schema-cache error in the write/verify path, not from missing knowledge.

**How to apply:** the running Express server only has the supabase-js client (service role) — it has NO direct Supabase Postgres connection, so `NOTIFY pgrst, 'reload schema'` is not available in-process; a bounded retry-with-delay is the practical mitigation. Keep the distinction sharp: a genuine missing node/edge in verification is a *returned verdict* (not a thrown exception), so it is never retried away — only thrown schema-cache errors are retried. See `withSchemaCacheRetry` / `isTransientSchemaCacheError` in `artifacts/api-server/src/lib/memory-graph.ts`.
