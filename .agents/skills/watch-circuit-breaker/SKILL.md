---
name: watch-circuit-breaker
description: Stop autonomous watches that are retrying the same blocker without material progress, then escalate once to Derek with the exact non-delegable action.
---

# Watch Circuit Breaker

Use this skill for recurring watches, orchestration heartbeats, deployment retries, monitoring loops, and other autonomous retry lanes.

## Trigger

Track consecutive failed executions for the same materially unchanged blocker.

Trip the circuit breaker when **5 consecutive attempts** fail for the same root cause without material state change.

A materially changed blocker resets the counter only when there is new evidence that changes the next viable action. A new runner IP, timestamp, job ID, or repeated provider error does **not** reset the counter when the root cause is unchanged.

## Required action at failure 5

1. Stop/disable the watch or recurring automation immediately.
2. Stop creating retries, branches, PRs, or workaround churn for that unchanged blocker.
3. Preserve the last known-good production/fallback state.
4. Record the five-failure circuit-breaker event in the canonical issue or execution log, including:
   - root blocker,
   - last failure evidence,
   - what was tried,
   - why further retries are nonproductive,
   - exact condition required to resume.
5. Alert Derek **once** with a concise outcome/blocker/next brief and exactly one action if founder input is required.
6. Continue any independent reversible work that is not blocked by the tripped circuit.

## Resume condition

Do not restart the watch merely because time passed.

Resume only when one of these is true:
- the blocking external/provider state changed,
- required credentials/permissions/configuration changed,
- a new technically distinct reversible path exists,
- Derek explicitly directs a retry.

After a verified material change, reset the consecutive-failure counter to zero.

## Escalation format

Keep the alert short:

**Outcome:** what remains healthy / what was stopped.

**Blocker:** the unchanged root cause after five failures.

**One action:** the exact founder-only action required, if any.

If no founder action exists, state that the watch was stopped and what event will justify resuming it.

## Anti-patterns

Never:
- keep rerunning the same provider call with rotating ephemeral runner IPs when IP policy is the blocker,
- treat cosmetic execution differences as progress,
- leave an hourly watch burning cycles indefinitely,
- send repeated alerts for the same tripped circuit,
- weaken security controls solely to keep the automation running.
