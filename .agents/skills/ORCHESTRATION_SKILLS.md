# Orchestration, Context, and Tooling Skills

## multi-agent-patterns
**Trigger:** Objective benefits from multiple workers.
**Procedure:** FOREMAN selects pattern deliberately: sequential pipeline for dependencies; fan-out/fan-in for independent investigation; specialist routing for domain work; evaluator-optimizer for quality loops. Set concurrency/budget/retry caps and deterministic ownership of orchestration state.

## context-degradation-detection
**Trigger:** Long-running task, repeated contradictions, forgotten constraints, looping, or scope drift.
**Procedure:** Compare current execution against objective/acceptance/prohibited-change contract; detect missing decisions or stale assumptions; checkpoint; refresh only relevant canonical context; replace worker if degraded rather than letting it improvise.

## context-compression
**Trigger:** Worker/session context grows large or crosses checkpoints.
**Procedure:** Preserve objective, decisions, constraints, evidence, current state, changed artifacts, blockers, next action, and provenance; discard conversational noise and superseded hypotheses; never compress away safety/licensing/privacy gates.

## durable-memory
**Trigger:** A decision, failure lesson, architecture rule, or verified procedure should survive worker/session death.
**Procedure:** Store concise provenance-backed memory in approved repository memory/runbook locations; separate facts from inference; version material changes; never persist secrets or unreviewed model speculation as truth.

## agent-evaluation
**Trigger:** Worker output must be judged before advancement.
**Procedure:** Evaluate against explicit acceptance rubric; prefer deterministic checks; score completeness/correctness/scope/safety/evidence; evaluator cannot waive missing required evidence; failures return exact correction requirements.

## tool-design
**Trigger:** Agents repeatedly struggle with a tool/API/workflow.
**Procedure:** Design narrow typed operations with clear preconditions, least privilege, deterministic outputs, idempotency where possible, safe failure modes, observability, and rollback. Prefer a small reliable tool over a broad ambiguous one.

## browser-runtime-testing
**Trigger:** User-facing web behavior or deployed runtime must be verified.
**Procedure:** Exercise real flows in browser automation when available; verify auth state, responsive/mobile behavior, error recovery, accessibility-critical controls, and visible acceptance; capture screenshots/logs where useful; runtime evidence outranks mocked assumptions.

## mcp-tool-builder
**Trigger:** Crew needs durable access to an external API/system not already exposed safely.
**Procedure:** Inspect official API/auth model first; define minimal tool surface and schemas; least-privilege credentials; validate inputs/outputs; add error/idempotency/rate-limit handling; test in non-production; document permissions and rollback. Do not build a new connector when an approved existing tool already fits.

## skill-workshop
**Trigger:** A procedure has solved the same class of problem repeatedly or materially improved execution.
**Procedure:** Propose—not silently self-install—a reusable skill with trigger, procedure, authority boundaries, tests/evaluation, provenance/licence, and rollback. Sandbox it; Inspector evaluates; Daz QC/QA approves promotion into the active stack.
