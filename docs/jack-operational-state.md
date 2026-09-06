# Jack operational state and internal agent boundary

Jack Core owns the state reducer in `lib/api-zod/src/operational-state.ts`.
Voice, HUD, radar adapters and future orchestration must use this contract instead
of implementing their own workflow state. The existing fictional Site HUD demo
retains its explicit opt-in, build flag and simulated position/transport model;
it is not a live crew observation source.

## Contract version 1

Every event has `version: 1`, a unique `id`, a strictly increasing server-assigned
`sequence`, an exact `scope` (`userId`, `organizationId`, `siteId`), `type`,
`audience` and a strict typed `payload`. Provenance includes `occurredAt`, `source`,
`severity`, `sessionId`, `crewId` and `correlationId`; task events also require
`taskId`. Internal events carry the applicable agent identifier. Organization and
pilot are also bound by database foreign keys to the existing telemetry session.
Unknown fields, versions and event types fail validation. Missing org/site means
unassigned, never a wildcard or an inferred membership.

| Event                                                                                              | Effect                                                                                                              |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `voice.listening.started`, `voice.listening.stopped`                                               | Listening, then interpreting                                                                                        |
| `intent.resolved`, `task.dispatched`, `task.progress`                                              | Dispatching, then working                                                                                           |
| `task.blocked`, `task.interrupted`, `task.failed`                                                  | Attention required                                                                                                  |
| `task.completed`, `task.recovered`                                                                 | Completed or working after recovery                                                                                 |
| `state.acknowledged`, `state.reset`                                                                | Acknowledge completion or return to idle                                                                            |
| `crew.heartbeat.missed`                                                                            | Missing heartbeat                                                                                                   |
| `crew.otg.entered`, `crew.otg.exited`                                                              | OTG, then reconnecting                                                                                              |
| `safety.alert`, `safety.resolved`                                                                  | Set or explicitly resolve a safety alert                                                                            |
| `authority.confirmation_required`, `authority.denied`, `authority.escalated`, `authority.resolved` | Set or explicitly resolve authority attention                                                                       |
| `connectivity.changed`, `confidence.changed`, `crew.awareness.changed`, `priority.changed`         | Typed cross-cutting observations                                                                                    |
| `agent.status.internal`                                                                            | Admin-only internal status; no public state change                                                                  |
| `agent.task.changed`                                                                               | Internal queued/running/blocked/interrupted/failed/recovered/completed tasks, owner, handoff target and model route |
| `agent.health.changed`                                                                             | Internal healthy/degraded/unavailable status                                                                        |

Cross-cutting enums are connectivity (`online`, `degraded`, `OTG`,
`reconnecting`), authority (`allowed`, `confirmation_required`, `denied`,
`escalate`), confidence (`normal`, `uncertain`, `safety_sensitive`), crew awareness
(`present`, `moving`, `missing_heartbeat`, `alone`), agent status (`active`,
`waiting`, `interrupted`, `failed`, `recovered`), and priority (`normal`, `urgent`,
`safety`). Initial connectivity is degraded and crew awareness is alone; these
defaults provide no evidence of location, crew presence or transport health.
`crewObserved` and `connectivityObserved` are false until a trusted observation;
surfaces display “no observation” while these flags are false.

The reducer rejects stale sequences, foreign scopes and task updates for another
task. Safety and authority attention survives progress, completion and user
acknowledgment until an explicit trusted resolution. It is a display model, not
an authority grant: `allowed` does not bypass any existing action authorization,
consent, licensing or safety check.

Public task IDs belong only to Jack-facing requests. Internal work must never be
published as field task events. The field projection is an explicit allowlist,
with no free text, worker names, agent state, internal event IDs or global sequence
numbers. Its public update count does not change for internal updates.

## Backend authorization and transport

Existing application authentication and pilot-access middleware remain intact.
Routes resolve the caller through the existing server-side Clerk identity logic.
Only a resolved, non-presentation admin may use these capabilities:

- `agent.command.*`
- `agent.status.internal`
- `agent.interrupt.*`
- `agent.dispatch.*`
- `agent.model.route`

Human foreman and superintendent roles do not imply internal agent access.
Client role flags, UI visibility, voice transcripts, targets and model output
cannot grant a permission. Future executors must call the same capability guard,
then enforce exact resource scope and all existing authority/consent checks.

| Endpoint                          | Boundary                                                                            |
| --------------------------------- | ----------------------------------------------------------------------------------- |
| `GET /api/operational/state`      | Signed-in resolved caller's own field projection                                    |
| `POST /api/operational/voice`     | Only `{type: "voice.listening.started"}` or stopped observations                    |
| `GET /api/admin/agents/state`     | Admin-only caller-scoped internal snapshot                                          |
| `POST /api/admin/agents/commands` | Admin capability check before target parsing; body `{permission, agentId, channel}` |

Field scope selectors are rejected. Admin filters may narrow organization, pilot,
user and session only after existing `authorizeReportScope` permission checks
and audit attribution. An admin role alone grants no new organization membership.
Site and crew selectors fail closed until real membership adapters exist; neither
pilot identity nor telemetry consent proves site/crew membership. Filters for
agent, event type, severity, task status and connectivity narrow the already
authorized history; the state is always replayed before applying filters.

There is no arbitrary event publishing HTTP route. Real site/crew ingestion must
wait for a trusted membership and consent adapter; the client cannot create one
by supplying IDs. State responses use `Cache-Control: no-store`.

Typed and transcribed Ask Jack requests share the same server guard. Recognized
internal agent addressing is refused for field users and directed to the admin
surface for admins. Natural-language detection is a UX guard, not a security
boundary: ordinary chat exposes no agent executor or model-routing tool.

The HUD is a read-only subscriber, backed by one per-user frontend subscription
store. It renders server snapshots; it never reduces workflow events or receives
internal permissions. The admin surface separately requests the protected
projection from the same bus. Both poll every three seconds while mounted/open,
rechecking server authorization each time. Failed fetches clear stale data;
identity changes abort outstanding requests. Jack request observation follows actual HTTP completion/failure and
the existing code-authority refusal, without storing questions or answers.

## One bus, durable history and privacy

`OperationalBus` is the publication/read boundary. With a current consented pilot
session, events append to `jack_operational_events` through the existing server
Supabase client before becoming visible. Both projections replay the same journal
using the shared reducer. No Command Centre state table or UI reducer exists.

The migration reuses existing telemetry consent/session lineage, membership and
account-deletion fences. An actor lock serializes sequence allocation with consent
withdrawal and account deletion. Insert validation binds event provenance to the
same actor, organization, pilot and session. RLS is enabled and direct `anon` and
`authenticated` table access is revoked; only server-mediated access is available.
The service role cannot update history. Withdrawal and account deletion purge
operational history; consent/session deletes cascade. The existing telemetry
retention worker removes expired operational rows after 90 days.

No optional consent is inferred or granted. Without an eligible session, the same
bus uses a bounded ephemeral adapter and reports `not_consented` in Command Centre.
That adapter retains at most 200 recent events per scope and expires after 30
minutes of inactivity (1,000 scopes maximum). Its defaults are display states,
never authority grants. Restart/eviction loses unconsented state by design.

Read and write consent is checked again at the database boundary and after
asynchronous work. A failed append is not reported as a persisted transition.
Command Centre exposes ingestion failures instead of displaying a false success.
No operational event contains transcript, answer, location coordinates or raw
arbitrary error text. Existing pilot analytics remain separate analytics, not a
second operational state machine; their permissions and event meanings are unchanged.

## Alerts and runtime limits

The shared alert projection detects missed heartbeats, degraded connectivity,
OTG lasting 15 minutes, tasks stuck for 10 minutes, three agent failures or three
recoveries in the retained session, safety/authority escalation, ingestion failure
and internal health degradation. Thresholds are operational warnings, not proof
of a person’s location or physical safety. Alert timers derive from event timestamps
at read time, so restarting the API does not reset durable task ages.

Durable replay paginates in 500-event batches and fails closed above 10,000 events
per session until checkpointing is introduced. The history response includes the
latest 200 matching events and marks truncation; filters never truncate replay.
The journal is shared across API instances. Failed appends record a fixed
`operational_event_gap` marker in the existing `activity_ingest_failures` table,
scoped to actor, organization, pilot and session and retained for 90 days. Reads
check those diagnostics with current consent so recorded gaps survive restart
and failover. A later successful append cannot clear an earlier missing transition.
Diagnostic read failures fail closed. Existing session resume requires the same
consent; renewed consent uses a new session.

If the database also rejects the diagnostic write, a bounded process-local
marker remains. That fallback cannot survive process loss, and an unrecorded gap
cannot be reconstructed after restart. No failed transition is invented in event
history. A failed context lookup or journal read returns 503; field reads fail
closed while a gap is known.

No internal worker executor is connected. Authorized command requests return
`501` explicitly rather than fabricating dispatch or success. This boundary
supports future executors; installing one requires durable idempotent dispatch,
scope authorization, authority checks, audit attribution, cancellation and
recovery. No shell command or arbitrary model is executed by this API.

OTG, heartbeat, confidence, authority resolution and recovery events are contract
capabilities for trusted adapters. They do not create live radar or radio support.
An authority alert is intentionally sticky in the current personal snapshot;
there is no field-facing endpoint that can dismiss the underlying gate.

Apply `20260906205400_jack_operational_events.sql` before deploying this code.
Local PGlite tests execute the actual migration and existing privacy fence
functions, test reopen/replay, scope rejection, SQL access denial and withdrawal.
They do not certify the full production migration chain or live acceptance.
Release tracking and remaining production gates are recorded in
`docs/jack-operational-state-release.md`. The tested schema rollback is
`supabase/rollback/jack_operational_events.sql`; it deletes operational history
and is for isolated verification or an explicitly approved restore procedure.
Prefer rolling back application code while retaining the additive schema and
history. Never run the destructive schema rollback automatically in production.

Tests cover strict contract validation, transitions, scope isolation, projection,
field/foreman/superintendent denial, spoofed admin input, admin-positive access,
voice-channel parity, failed identity resolution and read-only HUD subscription.
