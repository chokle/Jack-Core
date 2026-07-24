# User-Test Feedback Release Runbook

This runbook prepares the user-test feedback workflow for release. It does not
authorize a database migration, Railway variable change, deployment, or merge.

## Database migration

The additive production migration is:

`supabase/migrations/20260724091752_add_test_feedback.sql`

Read-only production inspection on 2026-07-24 confirmed:

- `public.test_feedback` does not exist.
- `public.mentor_profiles` exists, so the optional profile foreign key is valid.
- `public.test_recordings` exists, has RLS enabled, and has no `anon` or
  `authenticated` table grants.

The migration creates only `public.test_feedback`, its constraints and indexes,
enables RLS, revokes browser-role access, and grants access to `service_role`.
It does not modify or backfill existing rows.

## Railway variables

Values must be configured in the `jack-core` project, production environment,
`@workspace/api-server` service. Never copy secret values into Git.

### Required runtime and build variables

| Variable | Purpose | 2026-07-24 production state |
| --- | --- | --- |
| `NODE_ENV` | Production cookies and logging | Configured |
| `BASE_PATH` | Frontend/API base path; expected `/` | Configured |
| `PUBLIC_SITE_URL` | Secure feedback links and canonical URLs; expected `https://jack.torchlabs.ca` | Configured |
| `VITE_CLERK_PUBLISHABLE_KEY` | Clerk browser build key | Configured, test-mode key |
| `CLERK_PUBLISHABLE_KEY` | Clerk server middleware key | Configured, test-mode key |
| `CLERK_SECRET_KEY` | Clerk server authentication | Configured, test-mode key |
| `ADMIN_EMAILS` | Comma/whitespace-separated server-side admin allowlist | Configured, one entry |
| `SUPABASE_URL` | Supabase project URL | Configured; matches the connected production project |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only database access | Configured |
| `OPENAI_API_KEY` | Jack inference pipeline | Configured |
| `RESEND_API_KEY` | Resend delivery API | **Missing** |
| `FEEDBACK_FROM_EMAIL` | Verified Resend sender, including optional display name | **Missing** |
| `FEEDBACK_NOTIFICATION_RECIPIENTS` | Comma/whitespace-separated alert recipients; pilot target is `derek@torchlabs.ca` | **Missing** |

`PORT` is provided by Railway and must not be hardcoded.

The one configured `ADMIN_EMAILS` entry is not `derek@torchlabs.ca`. Its value
was not printed. Confirm the intended administrator before release.

The proposed sender is
`FEEDBACK_FROM_EMAIL=Jack Feedback <feedback@torchlabs.ca>`, but it must not be
configured until Derek confirms that exact address and the domain/address is
verified in the selected Resend account. The historical
`noreply@jack.torchlabs.ca` Clerk sender does not prove Resend verification.

### Migration-only variable

| Variable | Purpose | 2026-07-24 production state |
| --- | --- | --- |
| `SUPABASE_DB_URL` | Direct/session-pooler Postgres URL used only by `setup:supabase` | **Missing** |

An unexpected variable named `SUPABASE_DB_RUL` is configured and is likely a
typo. Its value was not inspected. Correcting or replacing it is a production
configuration change and requires explicit authorization.

### Optional Clerk proxy variables

| Variable | Purpose | State |
| --- | --- | --- |
| `JACK_CLERK_PROXY_TARGET` | Allowed Clerk Frontend API target override | Configured |
| `JACK_CLERK_PROXY_SECRET` | Dedicated server proxy secret override | Configured |
| `VITE_ENABLE_CLERK_PROXY` | Enables Clerk's browser `proxyUrl` setting when exactly `true` | Missing; defaults disabled |
| `VITE_CLERK_PROXY_URL` | Browser proxy URL; required only when the preceding flag is enabled | Missing |
| `VITE_DISABLE_CLERK_PROXY` | Legacy setting not read by the current frontend | Configured but obsolete |

The three configured primary Clerk keys match each other, but they are test-mode
keys. Confirm whether the production domain is intentionally staying on the
Clerk development instance before release.

## Two-account authorization matrix

Use two separate browser profiles or private windows. Do not reuse a session.

| Check | Account A: authorized admin | Account B: normal tester |
| --- | --- | --- |
| Identity | Sign in with the sole address currently present in `ADMIN_EMAILS` | Sign in with a Clerk account not present in `ADMIN_EMAILS` |
| `GET /api/me` | `200`, `isAdmin: true` | `200`, `isAdmin: false` |
| Review navigation | Full Review controls and User-Test Feedback section visible | No User-Test Feedback section or admin controls |
| `GET /api/testing/feedback` | `200` | `403` |
| `GET /api/testing/feedback/:id` | `200` for an existing record | `403` |
| `PATCH /api/testing/feedback/:id` | Can update status and admin notes | `403`; row remains unchanged |
| `POST /api/testing/feedback` | Authenticated route; normally not used by an admin | `201` for valid consented feedback |
| Anonymous control | In a third signed-out window, protected API routes return `401` | Same |
| Public probes | `/api/healthz` and `/api/system-health` remain reachable | Same |

Record the Clerk user IDs, test time, HTTP results, and feedback record ID in
the release evidence. Do not record passwords, tokens, interview answers, or
private prompts.

## Manual release tests

### Feedback submission and persistence

1. Sign in as Account B and explicitly accept the user-testing consent prompt.
2. Use at least one tracked feature for at least 30 seconds.
3. Trigger feedback through logout, completed Ask Jack use, completed interview,
   or desktop exit intent.
4. Verify all four required questions and `Yes / Partly / No` are available.
5. Submit once and capture the returned feedback ID.
6. Verify logout continues after submission.
7. Sign in as Account A and confirm one authoritative row appears as `New`, the
   unread count increments, and tester/trade/time/usefulness/text/features/device/
   trigger fields match without containing prompts or interview answers.
8. Refresh and confirm the row persists.

### Admin workflow and restrictions

1. As Account A, filter by trade, `New`, usefulness response, and a date range.
2. Open the detail view, add an admin note, and transition through `Reviewed`,
   `Actioned`, and `Archived`; verify the unread count changes when leaving
   `New`.
3. Refresh after each update and verify state persistence.
4. Repeat list/detail/update requests as Account B and signed-out; require
   `403` and `401` respectively, with no response data or mutation.

### Email delivery

1. Configure a Resend API key, a sender address verified in that Resend account,
   and `FEEDBACK_NOTIFICATION_RECIPIENTS=derek@torchlabs.ca`.
2. Submit a new Account B feedback record with a fresh feedback UUID.
3. Verify delivery changes `pending` to `sent`, attempts becomes `1`, and the
   email reaches the intended inbox once.
4. Verify subject, tester summary, trade, usefulness, features, device, trigger,
   timestamp, and secure Review link.
5. Verify the email contains no interview answer, prompt, transcript, unrelated
   session content, secret, or service-role data.
6. Open the secure link signed out (must require login), as Account B (must not
   reveal the record), and as Account A (must open the matching Review record).
7. Re-submit the same feedback UUID and verify one database row and no duplicate
   email. The API should return the existing record and Resend receives the same
   idempotency key.

### Failure and logout continuity

Run provider-failure injection only in a local or approved staging environment,
not by breaking production variables.

1. With `RESEND_API_KEY` absent, submit feedback and verify the row persists,
   notification becomes `failed`, a coded error is logged, and logout succeeds.
2. With `FEEDBACK_NOTIFICATION_RECIPIENTS` absent, repeat the same assertions.
3. Stub Resend with a `503`; verify `retrying`, attempt count increment,
   `notification_next_attempt_at`, eventual retry, and no private content in logs.
4. Exhaust three attempts; verify terminal `failed` without deleting feedback.
5. Force the feedback API request itself to fail; verify the draft remains on
   the tester device and logout still completes.
6. Restore the provider and submit a fresh record; verify normal delivery.

## Release ownership

Codex can prepare and verify code, SQL, tests, variable-name presence, PR
artifacts, and read-only production metadata.

Derek or an explicitly authorized operator must:

1. Confirm the exact admin and normal-tester email identities.
2. Confirm the intended verified sender address for `FEEDBACK_FROM_EMAIL`.
3. Supply or authorize creation/use of the Resend API key.
4. Confirm whether Clerk test-mode keys are intentional for production.
5. Authorize correction of `SUPABASE_DB_RUL` to `SUPABASE_DB_URL`, if the
   repository setup script will be used.
6. Explicitly authorize applying the migration and changing Railway variables.
7. Sign in as both accounts for the production two-account and inbox tests.
8. Authorize deployment and, separately, merging the PR.
