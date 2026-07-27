# Jack activity telemetry event specification

Status: Phase 2 implementation specification. Schema version: `1`.

Jack activity telemetry is optional, first-party pilot measurement. It is not a
copy of product content and it is not surveillance. Collection starts only
after explicit telemetry consent. Declining or withdrawing consent never
blocks normal Jack access.

## Canonical envelope

Every accepted event contains:

| Field | Source | Rule |
| --- | --- | --- |
| `event_id` | client or server | UUID; idempotency key |
| `actor_user_id` | server | Clerk user ID; never accepted from the client |
| `organization_id`, `pilot_id` | server | Active Supabase membership |
| `test_session_id` | server | Owned, active canonical pilot session |
| `app_session_id` | client session | UUID persisted for the browser tab session |
| `event_type` | event definition | Allowlisted below |
| `occurred_at`, `received_at` | client/server | ISO timestamp; server rejects unreasonable client time |
| `surface`, `route` | event definition | Allowlisted product surface and `/app` route only |
| `schema_version` | client/server | Must equal `1` |
| `metadata` | event definition | Exact allowlisted keys only; no free-form values |
| `consent_state`, consent/privacy versions | server | Snapshot of the current granted telemetry consent |
| app/deploy version | build | Short release identifiers only |
| `device_category` | client | `desktop`, `tablet`, or `mobile` |
| `browser_family` | server | `Chrome`, `Safari`, `Edge`, `Firefox`, or `Other` |
| `result` | event definition | `success`, `failure`, `cancelled`, or `unavailable` |
| correlation/request IDs | client/server | Opaque bounded identifiers; never content |
| retention | server | Raw activity category, 90 days |

Never include names, emails, prompts, answers, recordings, auth/payment data,
tokens, full user-agent strings, raw error bodies, clipboard/keystroke data,
screen content, precise device fingerprints, or unlisted metadata.

An event ID or session-scoped `dedupe_key` is an idempotent retry only when the
stored actor, session, app session, event type, result, and permitted metadata
match the retry. Conflicting reuse is rejected and cannot update session state.

## Events

| Event | Authority and trigger | Surface | Permitted metadata | Result |
| --- | --- | --- | --- | --- |
| `test_started` | Server, after granted telemetry consent creates the canonical session | pilot | none | success |
| `test_resumed` | Server, idempotent Start Test returns an active session | pilot | none | success |
| `test_completed` | Client workflow after feedback/test completion | pilot | none | success |
| `test_abandoned` | Client explicit abandon action | pilot | none | cancelled |
| `test_expired` | Server when an inactive test session expires | pilot | none | unavailable |
| `onboarding_started` | Client opens first incomplete onboarding step | onboarding | none | success |
| `onboarding_step_completed` | Client advances a step | onboarding | `step`, `next_step` | success |
| `onboarding_completed` | Client completes onboarding | onboarding | none | success |
| `onboarding_skipped` | Client skips onboarding | onboarding | `step` | cancelled |
| `feature_viewed` | Client enters an allowlisted feature | app | `feature` | success |
| `workflow_completed` | Client completes an allowlisted workflow | app | `workflow` | success |
| `ask_jack_completed` | Server only, after the answer and citations are durably stored | ask_jack | `citation_count` | success |
| `ask_jack_failed` | Server only, when the completed API request fails | ask_jack | `error_code` | failure |
| `recording_started` | Client after the browser grants screen permission | recording | `microphone_included` | success |
| `recording_stopped` | Client after capture stops | recording | `stop_reason` | success/cancelled |
| `recording_upload_succeeded` | Client after private upload confirmation | recording | none | success |
| `recording_upload_failed` | Client after upload fallback | recording | `error_code` | failure |
| `feedback_submitted` | Client after durable feedback API confirmation | feedback | none | success |
| `reliability_error` | Client for allowlisted operational failures only | reliability | `error_code` | failure |

Allowlisted `feature` values: `memory_graph`, `library`, `interview_mode`,
`knowledge_review`, `video_detail`.

Allowlisted `workflow` values: `interview_completed`,
`knowledge_review_completed`, `video_reviewed`.

Allowlisted error and stop values are stable codes defined beside the API
validator. Raw messages and exception text are prohibited.

## Consent and product-content separation

- Telemetry, screen recording, and microphone recording are three independent,
  versioned consent scopes.
- Screen and microphone are off unless separately granted. Microphone is never
  requested automatically.
- Ask Jack questions and answers remain in `chat_messages` as product history
  while the account is active. Activity events store only request outcome and
  citation count.
- Ask Jack uses an opaque test-session header only as a correlation hint. The
  server verifies that the session is active and owned by the caller; if no
  hint is supplied, an event is emitted only when exactly one active session
  exists, preventing cross-pilot misattribution.
- Pilot feedback remains available to active pilot members who decline
  telemetry. It is retained separately and never copied into activity events.
- Pilot report APIs never join or return `chat_messages.content`.
- Withdrawal stops ingestion immediately, cancels active capture, redacts
  optional event identifiers/metadata, and schedules attributable telemetry and
  recordings for deletion within 30 days.
- Local telemetry and capture stop before the withdrawal network request is
  attempted. Actor-owned retained consent history permits withdrawal after the
  membership expires or the pilot ends.
- Presentation mode is derived server-side from trusted Clerk private metadata.
  Client-supplied identity or metadata cannot enable or disable it; the retired
  synthetic identifier is supported only for legacy compatibility.
- Individual withdrawal does not delete de-identified `pilot_summary` report
  snapshots, which remain governed by the derived-report retention policy.

## Retention categories

- Recording objects and metadata: 30 days.
- Raw activity events: 90 days.
- Payload-free ingestion failure counters: 30 days.
- Feedback: 12 months after resolution or pilot end.
- Derived report snapshots: 12 months.
- Consent audit records: 24 months after withdrawal or pilot end.
- Admin report-access audit records: 24 months after the access decision.

Account deletion removes all attributable product and pilot data. Derived
statistics may remain only when they contain no user-level identifiers or
small-cell data that could reasonably re-identify a participant.

Weekly reports are not implemented or scheduled by this specification. Any
future schedule requires separately approved recipients, scope, configuration,
and authorization.
