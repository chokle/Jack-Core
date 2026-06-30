---
name: Supabase silent write errors
description: Supabase JS returns errors instead of throwing — unchecked writes in background jobs strand rows in non-terminal status.
---

The `@supabase/supabase-js` client returns `{ data, error }` and does NOT throw on a
failed query. An `await supabase.from(...).update(...)` that fails returns an error
object you must inspect; the surrounding `try/catch` will never fire on its own.

**Why:** In the async transcribe/analyze pipeline, the final
`update({ status: 'ready', key_points, competency_codes })` writes GPT output into
`text[]` columns. If the model returns a malformed array, the write fails — but
because the error was ignored, the catch block never ran and the row stayed
`analyzing` forever, so the frontend status-polling never reached a terminal state.

**How to apply:** In any background job that drives a status state machine, (1)
runtime-normalize model output before writing typed columns (filter to `string`
for `text[]`), and (2) check `{ error }` on the *terminal* write and `throw` it so
the catch can fall back to a guaranteed terminal status (`ready` if a transcript
exists, else `error`). Same rule for `supabase.rpc(...)` in the RAG path — a swallowed
RPC error silently degrades to "no internal knowledge" and drops all citations; log it.
