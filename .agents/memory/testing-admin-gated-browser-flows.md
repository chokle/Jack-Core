---
name: Testing admin-gated browser flows
description: How admin auth works now (Clerk email-role) for testing Knowledge Review flows, and the Supabase-seeding gotchas that trip up the test harness.
---

Admin access is now **Clerk email-role RBAC**, NOT a password / `JACK_ADMIN_KEY`
session cookie. A user is an admin iff they sign in via Clerk with an email in the
`ADMIN_EMAILS` allowlist (fail-closed: unset allowlist ⇒ nobody is admin). There is
no `/api/admin/login`, `/api/admin/logout`, `/api/admin/session`, or `/api/admin/dev-login`
anymore — the whole `routes/admin.ts` file and the password-session machinery were
removed when auth migrated to Clerk. `requireAdmin` resolves the caller from
`getAuth(req).userId` → `clerkClient.users.getUser` → `isAdminEmail`.

**Browser tests CAN now sign in as admin (helper built) — see
`docs/testing-admin-flows.md` for the full recipe.** The Replit testing skill
signs users in programmatically: call `runTest({ testClerkAuth: true })` and add a
`[Clerk Auth] Sign in as {email}` step. That user is an admin iff `email` is on the
`ADMIN_EMAILS` allowlist, so the "helper" is just: sign in as an allowlisted email —
no dev-login route, no cookie minting (the old password-less `/api/admin/dev-login`
was removed in the Clerk migration). Conventions:
- Canonical browser-test admin email: `jack-e2e-admin@example.com` (plain — the
  harness sign-in is programmatic, so no `+clerk_test` needed). Must be added to the
  `ADMIN_EMAILS` **secret** (never a shared env var → plaintext in tracked `.replit`);
  it's read once at api-server module load, so **restart the api-server after setting
  it** and confirm the `ADMIN_EMAILS is not set` warning is gone before spending a
  runTest cycle. Secrets are global → tell the user to drop the test email before publish.
- Simplest reopen fixture: a `knowledge_candidates` row `status='rejected'` +
  non-null random-UUID `mentor_profile_id` (that column has NO FK). Reopen of a
  rejected row is a pure CAS flip to pending — touches no graph nodes, so it dodges
  the restore topic-hub FK dance entirely. "Reopen for review" button shows for
  rejected/accepted/merged AND `candidate.mentorProfileId` set.

**Seeding is the real friction, independent of auth.** The testing subagent's `[DB]`
step talks to the built-in Replit Postgres, NOT Supabase (this app's source of truth),
so `[DB]` inserts fail with `relation "knowledge_candidates" does not exist`. Seed an
archived candidate yourself against Supabase's PostgREST from bash (service key from
env, never printed): `POST $SUPABASE_URL/rest/v1/knowledge_candidates`. Two gotchas:
- The restore edge targets `topic:<trade>` verbatim, so the candidate's `trade` MUST
  match an existing topic hub (query `knowledge_nodes?id=like.topic:*` first — e.g.
  `Welder`, not `welding`), or restore 500s on a FK violation.
- Node `label`/`trade` are first-writer-wins. A failed restore that already minted the
  concept node pins the wrong trade; delete the stray `k:concept:*` node (and its
  edges) before retrying, or the corrected candidate trade is ignored.
Clean up afterward (delete candidate + any minted `k:concept:*` node/edges).

**Resolve-response shape:** the resolve endpoint returns the candidate **flattened at
top level** (via `ResolveKnowledgeCandidateResponse.parse(result.candidate)`) — read
`.status`, not `.candidate.status`. Assert authoritative state via the tab listings
(`GET /api/graph/candidates?status=...`) and the graph node (`knowledge_nodes`).
