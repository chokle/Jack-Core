---
name: PostgREST bulk upsert overrides column defaults with NULL
description: Mixed-column batches in a single supabase upsert insert explicit NULL for omitted columns, bypassing NOT NULL DEFAULT.
---

When a single `supabase.from(...).upsert([...])` call contains rows with DIFFERENT
key sets, PostgREST unifies the column list across the whole batch. Rows that
OMIT a column are then inserted with an explicit `NULL` for it — the database
column DEFAULT does **not** apply. If that column is `NOT NULL DEFAULT <x>`, the
whole batch fails with a NOT NULL violation.

**Why:** knowledge_edges has `weight FLOAT NOT NULL DEFAULT 1` and
`meta JSONB NOT NULL DEFAULT '{}'`. Mentor ingestion upserts weighted provenance
edges together with weightless/meta-less hub (topic/competency) edges in one
call. The hub edges silently got `weight=NULL, meta=NULL` and every mentor answer
distillation failed (caught + logged), so mentor concepts never entered the graph
and Mentor Withdrawal had nothing to archive. The video pipeline never hit it
because its hub edges always set a weight.

**How to apply:** in any shared edge/row upsert helper, ALWAYS set every
NOT-NULL-with-default column explicitly (e.g. `row.weight = e.weight ?? 1`,
`row.meta = e.meta ?? {}`) rather than conditionally omitting it. Never rely on
the DB default inside a batched upsert whose rows may have heterogeneous keys.
