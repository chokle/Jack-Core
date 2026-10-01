# Cloudflare runtime persistence foundation

Authority: founder directive relayed by Daz, authenticated Radio sequence 91 on 2026-10-01. Owner: Dex. This isolated foundation does not change Jack's application database, API, knowledge authority, production Worker, container, routes or product surfaces. Tila owns the separate operational specification; this document describes implementation and the proposed resource map for her review.

Branch: `feat/cloudflare-persistence-foundation-20261001`, based on `e2e644dcb687b61844c014d99f6a6cc7deeff1b8`. Durable checkpoint: `D:/TORCH/deliverables/task-state/cloudflare-persistence-foundation-20261001/checkpoint.json`.

## Boundaries and state ownership

The Worker is an internal operator frontdoor. It requires separate read/write bearer secrets (minimum 32 characters, unequal); missing configuration fails closed with 503. These tokens are service administration credentials, not Clerk user identities or a tenant membership mechanism. This service must not be wired to Jack's browser/native client. The only public route, `GET /healthz`, reports that the runtime responds; it does not expose task IDs, receipts, readiness, secrets, model activity or a persistence acceptance claim. Private responses use `Cache-Control: no-store`.

`TASK_STATE` maps the canonical JSON tuple `[agent ID, task ID]` to a SQLite Durable Object. Agent IDs and task IDs are opaque operator-assigned identifiers, never names, emails, prompts or knowledge content. Each object owns a single task's lease, monotonically increasing fencing token, attempt budget, version and operation receipts. There is no global singleton. An agent's tasks remain separate coordinators; an agent-wide scheduler or lock is outside this foundation.

The state machine is `queued → running → completed`, or `running → retryable → running`, ending at `blocked` after three verified failures. A killed or expired owner moves `running → awaiting_reconciliation`. That state cannot be claimed. A privileged operator must first check the external operation and submit a receipt proving success or failure. The operation ID and attempt are committed before an executor is permitted to perform its side effect. Completion requires the current owner, unexpired lease, operation and fence. Durable Objects serialize these transitions using SQLite `transactionSync`; no external I/O runs inside that transaction. See [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

The foundation stores opaque receipt references, not provider credentials or raw payloads. The caller is responsible for verifying the referenced evidence and enforcing the fencing token at any downstream resource. This ledger does not itself authenticate a provider receipt, make a provider idempotent or guarantee exactly-once external execution. There is no external executor or model loop in this PR.

An explicitly invoked `RecoveryWorkflow` performs three bounded steps: recover/read canonical DO state, archive a minimal operational projection in private R2, and publish that projection to Queues. Each step permits two retries (three attempts total) with a 30-second timeout. Deterministic R2 keys and version-conditional D1 upserts tolerate duplicate delivery. The workflow does not execute a model or replay a provider operation. There is no cron, HTTP workflow-trigger endpoint or automatic workflow creation in this foundation. Approved callers can later use the `RECOVERY_WORKFLOW` binding with recorded, deterministic instance IDs. Workflows retain step outputs; payloads must remain opaque and minimal. See [Workflows API](https://developers.cloudflare.com/workflows/build/workers-api/) and [Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/).

Queues decouple operational reporting. The consumer writes only status, version, attempt count and update time to D1. D1 is a disposable cross-task projection, never a lease or recovery authority. Invalid envelopes are discarded; database failures retry and eventually reach a dead-letter queue. The dead-letter queue has no automatic consumer; its reconciliation actor must be assigned before live activation.

R2 is for private artifacts; this slice archives only minimal operational checkpoints. Raw prompts, audio, answers and provider responses have no ingestion route. Before any future provisioning, keep `r2.dev` disabled, attach no public/custom-domain bucket access, and agree lifecycle/deletion rules. DO receipt retention, deletion and an account-scoped task discovery index also require an operational policy before live activation.

AI Gateway is the future model observability/control boundary. The proposed gateway ID is recorded as a nonsecret variable; no provider calls, Gateway resource or Gateway credentials are used here. Before model integration, approve request/response logging and retention, authenticate the Gateway, preserve private data boundaries, establish model budgets, and reconcile provider receipts through the DO. Gateway configuration alone is not a persistent worker or recovery supervisor.

## Internal request contract

`GET /v1/agents/:agent/tasks/:task` accepts a read or write token and returns `{state, receipts}`. `state` is null until creation. A missing task is not created by a status read. IDs match `[A-Za-z0-9_-]{1,80}`. POST on the same route requires the write token, JSON with no extra fields, and at most 2 KiB:

| Action | Fields |
| --- | --- |
| Create | `{"action":"create"}`; repeat creation preserves existing state |
| Claim | `action`, `owner`, `operation`, `leaseMs` (integer 1,000–300,000); returns persisted intent and fencing token |
| Finish | `action`, `owner`, `operation`, `fence`, `result`, `reference` |
| Reconcile | `action`, `operation`, `fence`, `result`, `reference`; privileged evidence submission after unknown outcome |

Result is `succeeded` or `verified_failed`. Opaque `owner`, `operation` and `reference` use the same ID grammar. POST returns `{ok,state}` on success; conflicts return 409 with a stable error code. A matching recorded finish is idempotent, while a conflicting receipt fails closed. No lease renewal exists: each execution must fit its declared finite lease, or reconcile its outcome.

## Proposed resources — none provisioned

All names below are proposals awaiting founder review. The Wrangler file has no routes, disables Workers development/preview URLs, and uses an all-zero unprovisioned D1 ID. The isolated package has no deployment script. Production configuration is untouched.

| Product | Exact proposed name / binding | Role |
| --- | --- | --- |
| Worker | `jack-runtime-persistence-foundation` | Operator API frontdoor |
| SQLite DO | `RuntimeTaskState` / `TASK_STATE` | Per-agent/task canonical state; migration `v1-runtime-sqlite` uses `new_sqlite_classes` |
| Workflow | `jack-runtime-recovery` / `RECOVERY_WORKFLOW` | Explicit recovery/reporting job |
| Queue | `jack-runtime-reporting` / `REPORT_QUEUE` | Async reporting delivery |
| Dead-letter queue | `jack-runtime-reporting-dead-letter` | Bounded failure holding queue |
| R2 Standard bucket | `jack-runtime-artifacts-private` / `ARTIFACTS` | Private checkpoint artifacts |
| D1 database | `jack-runtime-operational-reporting` / `REPORTING_DB` | Cross-entity operational reporting only |
| AI Gateway | `jack-runtime-control` / variable `AI_GATEWAY_ID` | Reserved model control boundary |

The names-only secret manifest requires `RUNTIME_READ_TOKEN` and `RUNTIME_WRITE_TOKEN`. `CF_AIG_TOKEN` and `MODEL_PROVIDER_API_KEY` are reserved for separately approved model integration and unused here. No secret values, account IDs, live credentials or provider tokens are included. There is no secret provisioning instruction in this delivery.

## Cost estimate, USD, verified 2026-10-01

Illustrative monthly pilot assumptions: 1,000 tasks, 20,000 frontdoor/DO calls, 1,000 explicitly triggered recovery workflows × three steps, 1,000 queue messages under 64 KB, 1,000 R2 writes, 0.1 GB DO SQLite, 0.1 GB D1, 0.1 GB R2, at most 100,000 SQL rows read/written per product, and fewer than 1 million CPU milliseconds. DO duration assumption is 2 seconds active per call × 0.128 GB = 5,120 GB-seconds, below the paid included amount. No model inference, guardrails inference, paid Gateway log export or unified billing is assumed. This is a sizing estimate, not observed account usage or a spend cap.

| Product | Current paid-plan rate / included usage relevant to this estimate |
| --- | --- |
| Workers | $5/month minimum plan; 10m requests and 30m CPU-ms included, then $0.30/million requests and $0.02/million CPU-ms. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| DO SQLite | 1m requests and 400k GB-seconds included; then $0.15/million requests and $12.50/million GB-seconds. 25b row reads, 50m writes and 5 GB-month included; overage $0.001/million reads, $1/million writes, $0.20/GB-month. [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| Workflows | Shared Workers request/CPU allowance; 500k steps and 1 GB-month included, then $0.80/100k steps and $0.20/GB-month. Step/storage billing is active since August 10, 2026. [Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/) |
| Queues | 1m operations included, then $0.40/million; normal delivery uses write/read/delete, so 1,000 messages ≈ 3,000 operations before retries. [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/) |
| R2 Standard | 10 GB-month, 1m Class A and 10m Class B operations free; then $0.015/GB-month, $4.50/million A, $0.36/million B; Internet egress free. [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| D1 | 25b rows read, 50m rows written, 5 GB included; then $0.001/million reads, $1/million writes, $0.75/GB-month. [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| AI Gateway | Core analytics/cache/rate-limit features free. New customers from September 24, 2026 use Workers Logs pricing/retention; provider inference is separate. Unified Billing adds a 5% credit-purchase fee, and guardrails incur Workers AI inference. [AI Gateway pricing](https://developers.cloudflare.com/ai-gateway/reference/pricing/) |

Under these assumptions, incremental infrastructure overage is approximately $0 if the existing account has the listed shared allowance headroom. A new paid Workers account would start at approximately $5/month. Existing account usage, billable-unit rounding, larger artifacts, long-lived DO activity, workflow retention, retries, logs and model usage can increase the bill. Pricing is subject to change; the account plan and actual remaining allowance have not been verified. No paid resource or subscription has been created.

## Local verification and remaining gates

From `cloudflare/persistence`, run `pnpm install --frozen-lockfile`, `pnpm test`, and `pnpm check`. `check` is a Wrangler bundle/config **dry-run**, not a deployment. Dependencies and lockfile are isolated from the root application workspace.

The test starts Miniflare with SQLite-backed Durable Objects, claims an operation, kills its actual workerd process tree, restarts a new runtime against the same persisted SQLite directory, checks that the unknown operation cannot be reclaimed, reconciles its receipt, and restarts again to confirm the receipt persists. It also checks concurrent ownership denial, stale fencing rejection, the three-attempt limit, separate read/write permissions and invalid input. The test's temporary credentials are generated locally and not retained in a receipt. This is local workerd/SQLite proof, not a Node in-memory state simulation, hosted DO proof or Jack product acceptance.

Before activation: founder approval of names/cost/PR; Tila's operational requirements; explicit provisioning/deployment authority; approved retention/deletion and reconciliation ownership; account headroom; operator network/access controls and secret rotation; integration executor/provider receipt checks; D1 migration; private R2 access evidence; actual hosted Workflow/Queue/D1/R2 tests; hosted kill/recovery acceptance; and a recorded handoff with the exact deployed version. No acceptance step should treat a healthy frontdoor or successful bundle as proof of recovery.
