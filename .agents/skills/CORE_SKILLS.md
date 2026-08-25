# Autonomous Engineering Core Skills

## subagent-driven-development
**Trigger:** Work contains independent bounded scopes.
**Procedure:** Decompose by dependency; give each worker one objective, inputs, acceptance test, prohibited changes, and output contract; parallelize only independent scopes; fan results back to FOREMAN; never let child instructions expand authority.

## worktree-isolation
**Trigger:** Two or more workers may edit code concurrently.
**Procedure:** Give each implementation lane an isolated branch/worktree; record base/head and owned paths; prohibit unrelated staging; reconcile only after verification; detect overlapping file ownership before dispatch.

## verification-before-completion
**Trigger:** Any worker claims ready/done/fixed.
**Procedure:** Require objective evidence appropriate to risk: focused tests, relevant full tests, typecheck, build, lint/format, `git diff --check`, direct diff inspection, and live/runtime acceptance where possible. Missing checks are reported as missing, never converted to confidence.

## systematic-debugging
**Trigger:** Failure, regression, flaky behavior, unexpected runtime result.
**Procedure:** Reproduce; capture evidence; minimize; form ranked hypotheses; test one variable at a time; identify root cause; implement smallest durable fix; add regression coverage; rerun verification.

## root-cause-tracing
**Trigger:** Same symptom recurs, downstream failure has unclear origin, or second occurrence of a failure mode.
**Procedure:** Trace backwards through call/data/event chain to first invalid state; distinguish cause from manifestation; fix at earliest safe boundary; convert repeat failures into guardrail/test/runbook/watchdog.

## test-driven-development
**Trigger:** Behavior can be expressed as deterministic acceptance criteria.
**Procedure:** Encode failing acceptance/regression test where practical; implement minimum change; make test pass; refactor without changing contract; run broader regression suite. Do not force TDD where test scaffolding would exceed the task or hide a live-only failure.

## branch-closeout
**Trigger:** Implementation lane reaches acceptance.
**Procedure:** Verify clean scope/status; rerun required checks; summarize exact changed files and residual risk; prepare commit/PR evidence; clean disposable worktree only after work is safely preserved; never treat PR creation as completion.

## subagent-testing
**Trigger:** Meaningful runtime/security/privacy/retrieval change.
**Procedure:** Use an independent verifier when useful; give verifier acceptance criteria and artifacts, not implementer's conclusions; test happy path, boundary, adversarial/failure path, and regression surface; send failures back into correction loop.

## code-review-response
**Trigger:** Human/CodeRabbit/scanner review findings arrive.
**Procedure:** Classify each finding valid/invalid/uncertain with evidence; fix valid findings; explain rejected findings technically; retest affected surface plus regression suite; resolve threads only after evidence exists.

## review-evidence-pack
**Trigger:** Work is ready for Daz QC/QA.
**Procedure:** Return objective, branch/SHA, changed files, diff summary, checks with counts/results, runtime evidence, known limitations, rollback, and GO/HOLD. Keep conclusions traceable to evidence.

## condition-based-waiting
**Trigger:** Task depends on CI, deployment, external state, or another worker.
**Procedure:** Prefer event/status checks over blind sleeping; continue independent work while waiting; bound retries/time; persist checkpoint; surface stale dependency; never spin indefinitely.
