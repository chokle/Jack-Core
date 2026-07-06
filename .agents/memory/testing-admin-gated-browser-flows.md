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

**Consequence for browser tests:** an earlier task built a non-prod, password-less
`/api/admin/dev-login` so Playwright could mint the old signed admin cookie in-browser;
that mechanism was superseded by the Clerk migration and no longer exists. To drive
admin-gated Knowledge Review UI in a real browser now, the test needs a real Clerk
session for an allowlisted email (e.g. a dedicated test Clerk user + the testing skill's
Clerk override), OR verify the admin flows below the UI via the API/DB. A Clerk-based
test sign-in helper is not yet built — treat that as open work if browser-DOM admin
coverage is required.

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
