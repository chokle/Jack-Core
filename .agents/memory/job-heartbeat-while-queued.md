---
name: Queued-job heartbeat vs. watchdog
description: Why a claimed job row deferred behind an async gate/queue must keep heartbeating while it waits.
---

# Queued-job heartbeat while waiting behind a gate

**Rule:** In the resilient job system, a row is *claimed* by flipping its status to an
in-flight stage and stamping `heartbeat_at`/`claimed_by`. If the actual run is then
**deferred behind any async gate, queue, or backpressure primitive**, something must keep
that row's heartbeat fresh (`claimed_by = INSTANCE_ID`) for the whole wait. The pipeline
does this by starting a heartbeat before awaiting a concurrency slot and stopping it once
the slot is acquired (the running stage then owns its own heartbeat).

**Why:** The recovery watchdog classifies any in-flight row whose heartbeat is older than
`STAGE_STALE_MS` (5 min) as stale and reclaims it — even a row we own. A claimed-but-queued
video that never heartbeats looks dead: the watchdog re-runs it (double concurrent
run, defeating the cap and doubling OpenAI spend) and, after `MAX_ATTEMPTS` reclaims,
marks it `failed` with "attempts exhausted" — a *false* failure. This bites hardest in the
exact bulk-upload scenario the gate exists for (dozens of clips, only N slots, deep queue
waits far exceeding 5 min).

**How to apply:** Any future queue/gate/semaphore/backpressure added between a `claimStage`
(or recovery reclaim) and the actual `runPipeline` MUST heartbeat while waiting, OR defer
the claim until just before the run. Don't lengthen `STAGE_STALE_MS` to paper over it —
that also delays genuine dead-process recovery.

Related test-harness gotcha: the api-server vitest `vi.mock("../openai.js", …)` factories must
export the `chatCompletion` wrapper (delegating to the shared fake `openai.chat.completions.create`),
not just patch the raw client — the pipeline and distiller call the wrapper, so a mock that
omits it throws "No 'chatCompletion' export is defined on the mock" for every test that
reaches the analyze/distill stage.
