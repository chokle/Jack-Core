# Daz implementation handoff — Jack pilot hardening review follow-up

Recipient: Daz

Prepared by: Dex (Codex)

Delivery status: delivered via Jack-Core PR #41; not reviewed by Daz

## Review surface

- Repository: `chokle/Jack-Core`
- PR: https://github.com/chokle/Jack-Core/pull/41
- Branch: `codex/jack-pilot-hardening`
- Base: `5da78f9`
- Original implementation: `8d82de3`
- Consent ordering remediation: `7959c10`
- Account consent-downgrade and admin-read follow-up: `503cfcf`

## Outcome

The open consent-review findings are corrected without weakening auth or privacy boundaries:

- Account & privacy choice changes now detect every previously granted scope changed to declined and route those scopes through `withdrawTelemetry()` before saving the new bundle. That existing withdrawal path dispatches the immediate local stop event and schedules attributable data deletion through the API.
- Reviewing choices does not start or resume a test session merely because activity telemetry remains granted. Initial pilot opt-in still starts the intended session.
- Admin conversation review now orders current consent by `occurred_at DESC, created_at DESC, id DESC`, exactly matching the database trigger and the participant-side linkage readers. Same-timestamp withdrawal therefore fails closed.

Changed in this follow-up:

- `artifacts/api-server/src/routes/conversation-review.ts`
- `artifacts/api-server/src/routes/__tests__/conversation-review.test.ts`
- `artifacts/jack-core/src/App.tsx`
- `artifacts/jack-core/src/App.user-testing-gate.test.tsx`

## Verification

- API focused conversation-review tests: 3/3 passed.
- Frontend focused consent-downgrade regression: 1/1 passed.
- Full API: 46 files, 519/519 tests passed.
- Full frontend: 36 files, 251/251 tests passed using the threads pool and a 15-second per-test limit after the default fork worker failed to start in this Windows environment.
- API and frontend package typechecks: passed.
- `pnpm run typecheck`: passed across API, Jack frontend, mockup sandbox, and scripts.
- `pnpm run build`: passed; existing sourcemap and large-chunk warnings only.
- Prettier: production files and API regression use repository style. The repository has no lint script; no lint result is claimed.
- `git diff --check`: passed.
- Static credential-pattern scan of the PR diff: no match.

## Migration impact

This follow-up adds no migration. PR #41 still contains one unapplied migration, `supabase/migrations/20260811190035_add_conversation_review_consent.sql`, adding the append-only consent table, scoped chat/test-session linkage, indexes, RLS/browser-role revocation, and the fail-closed ownership/current-consent trigger. It stores no raw Q/A. The migration was statically inspected and covered by repository tests; it was not executed because production and migration mutations remain forbidden.

## Boundaries and follow-up

- No production membership/data mutation, deployment, migration execution, merge, or shared-node blanket deletion was performed.
- Video ingestion semantics were not changed.
- Daz should review the latest PR head, the consent downgrade transition in `App.tsx`, and the migration before any staging/release decision.
