# Jack operational state release evidence

Date: 2026-09-06. Base implementation: `6ea60ed7300ed6fae7364cc21f6f899c34cc9d93`.
PR: https://github.com/chokle/Jack-Core/pull/145

## Integration review

Independent source review found no authoritative site/crew membership adapter.
`activity-telemetry.ts` supplies organization/pilot membership and scoped report
grants only. Site HUD fixtures are fictional observations. Site/crew selection
continues to fail closed; no client metadata is accepted as membership.

`jobs.ts` executes video pipelines, and feedback workers deliver notifications.
Neither provides a named Dex/Foreman/Sweeper/Journeyman executor. Repository agent
handoffs are engineering instructions, not application execution endpoints.
Existing legacy Command Centre tables lack tenant attribution; the process-global
vitality stream also lacks session attribution. None is a safe substitute.
Commands retain explicit 501 responses after the common admin authorization guard.
No live worker command or membership integration is claimed.

## Database and rollback

Gap diagnostics now reuse `activity_ingest_failures` with exact scope, a fixed
content-free reason and 90-day retention. Recorded gaps survive a new bus instance;
diagnostic reads fail closed. Existing consent and deletion fences apply. When
both event and diagnostic writes fail, only the local sticky marker is available;
losing that process still loses knowledge of the unrecorded gap. There is no
claim of complete outage recovery or a second operational event stream.

The user explicitly excluded connected Supabase project `mdqdswhzkocglbnxvxth`,
named "Torch leads": it is not Jack's application database and must not be used.
Its schema was inspected read-only before this clarification; no mutation occurred.
Jack's actual project references must be positively identified from its existing
deployment configuration after connecting the owning Supabase account. Similar
table names are not sufficient evidence of target identity.
The local Supabase CLI has no access token; local Docker has no running engine.
No deployed nonproduction database target is currently available to this session.

The actual operational migration and rollback run against the existing PGlite
fixture. Tests cover forward application, atomic rollback rejection on unexpected
dependencies, successful rollback, preservation of existing telemetry records and
privacy functions, forward reapplication, duplicate ID rejection, disk reopen,
replay and privacy fences. These tests do not certify the full target migration
chain or backup/restore of production data.

Production rollback preference is the previous application artifact, retaining
the additive journal schema. The explicit schema rollback deletes journal data;
it is not authorized for automatic production execution. No production mutation
has occurred in this release attempt.

## Release gates

The baseline PR's operational verification and Cloudflare cutover verification
both passed. Aikido and Semgrep passed. CodeRabbit reported "review skipped";
that is not a completed CodeRabbit review. Independent source review confirmed
the backend permission boundary and identified the integration blockers above.
Final-head verification is recorded in the PR checks and local release logs.

The production workflow deploys automatically on a main-branch push. Therefore
merge is held while membership/executor integration, nonproduction migration
validation and authenticated acceptance remain unavailable. No checks are bypassed.

Authenticated live HUD/Command Centre convergence, real worker execution,
tenant/site/crew isolation, voice execution, consent withdrawal/account deletion,
restart recovery and replay-cap acceptance are pending. Automated local/CI tests
are not production evidence. Physical/mobile acceptance is also pending.

Status: **NOT DONE**. Required inputs are the existing trusted membership and
named-agent executor service contracts/access, a verified nonproduction database
target with an approved restore path, and authorized acceptance identities.
