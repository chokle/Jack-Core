---
name: Idempotent background jobs (transcribe/analyze)
description: Why video transcribe/analyze must acquire their job slot with one conditional UPDATE, not read-then-write.
---

# Idempotent background AI jobs

The transcribe and analyze endpoints kick off async OpenAI jobs (Whisper / GPT)
via `setImmediate`. Each must run **at most once per video** — a re-run is a
direct, duplicated dollar cost.

**Rule:** acquire the job slot with a single conditional `UPDATE ... WHERE` that
sets the in-progress status, then only enqueue the background job if a row was
returned. Never read state first and then write in a separate statement.

- transcribe acquire: `update({status:'transcribing'}).eq(id).is('transcript', null).neq('status','transcribing').select('id').maybeSingle()`
- analyze acquire: `update({status:'analyzing'}).eq(id).not('transcript','is',null).is('analysis', null).neq('status','analyzing').select('id').maybeSingle()`
- If no row returned, re-read the row to disambiguate the 404 / cached(200) / in-progress(202) response.

**Why:** read-then-write is non-atomic. Two concurrent requests can both read
"not started" and both launch the OpenAI job, double-spending. A single
conditional UPDATE is atomic — Postgres row-locks it and re-checks the WHERE for
the loser, so exactly one request wins the slot.

**How to apply:** any new endpoint that triggers a paid background job keyed on a
DB row should use the same acquire-by-conditional-update pattern. Also coalesce
concurrent identical embedding calls (in-flight promise map in
`api-server/src/lib/openai.ts createEmbedding`) for the same reason.
