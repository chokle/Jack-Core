# Testing admin-gated flows in a real browser

Admin surfaces (Knowledge Review — verify / merge / reject / **Reopen & Undo** /
restore / re-archive, plus Mentor Withdrawal, Graph Health, analytics, exports)
are gated by **Clerk email-role RBAC**: a signed-in user is an admin iff their
email is in the `ADMIN_EMAILS` allowlist (see `docs/architecture.md` and
`artifacts/api-server/src/lib/admin-auth.ts`). The Playwright testing subagent
can drive these surfaces end-to-end — no more falling back to `curl`/unit tests
"below the UI".

This is the reusable recipe. Reach for it for **any** admin-gated browser check.

## 1. One-time setup: a browser-test admin on the allowlist

The testing harness signs a user in programmatically; that user is only an admin
if their email is on `ADMIN_EMAILS`.

- **Canonical browser-test admin email:** `jack-e2e-admin@example.com`
- `ADMIN_EMAILS` is a **managed secret** (comma/space-separated), never a shared
  env var — a shared env var writes plaintext into the tracked `.replit`. It is
  read **once at api-server module load**, so after changing it you must
  **restart the `artifacts/api-server: API Server` workflow**.
- Ask the user to set `ADMIN_EMAILS` to include this test email **alongside**
  any real admin email(s), e.g. `you@company.com, jack-e2e-admin@example.com`.
- Verify it took effect: after the restart, the api-server logs must **not**
  show the `ADMIN_EMAILS is not set` warning before you spend a `runTest` cycle.

> **Before publishing:** secrets are global (dev **and** prod share one
> `ADMIN_EMAILS`). Have the user remove `jack-e2e-admin@example.com` from
> `ADMIN_EMAILS` before/at go-live so the test identity is never an admin in
> production. (Risk is low — prod Clerk uses live keys and `example.com` mail is
> unreceivable — but keep the prod allowlist to real people.)

## 2. Sign in as the admin from a test plan

Pass `testClerkAuth: true` to `runTest`, then sign in with a `[Clerk Auth]`
step (fully programmatic — do **not** script Clerk's sign-in UI). Any email you
name is signed in as-is; naming the allowlisted email yields an admin session.

```javascript
await runTest({
  testClerkAuth: true, // REQUIRED to unlock programmatic Clerk sign-in
  testPlan: `
    1. [New Context] Create a new browser context
    2. [Clerk Auth] Sign in as {firstName: "E2E", lastName: "Admin", email: "jack-e2e-admin@example.com"}
    3. [Verify] The app shows a signed-in state and the admin-only "Knowledge Review"
       entry is reachable (it renders only when GET /me returns isAdmin:true — so
       its presence is itself proof admin auth worked).
    ...admin steps...
  `,
});
```

## 3. Seed fixtures in Supabase (not the [DB] step)

The subagent's `[DB]` step talks to the built-in **Replit Postgres**, not
**Supabase** (this app's source of truth), so `[DB]` inserts fail with
`relation "..." does not exist`. Seed against Supabase's PostgREST from bash
before calling `runTest`, using `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
(never print the key). Always clean up afterward, even on failure.

### Minimal reopen fixture (rejected candidate)

A `knowledge_candidates` row with `status='rejected'` and a **non-null**
`mentor_profile_id` is the simplest reopen fixture: `mentor_profile_id` has **no
FK** (only the interview tables do), and reopening a *rejected* row is a pure
status flip to `pending` — it touches **no** graph nodes (the accept/merge undo
and the restore topic-hub FK never run). Required NOT NULL columns: `id`,
`title`, `category`.

```bash
CID="k-test:e2e-reopen-$(cat /proc/sys/kernel/random/uuid | cut -c1-8)"
MPID="$(cat /proc/sys/kernel/random/uuid)"
curl -sS -X POST "$SUPABASE_URL/rest/v1/knowledge_candidates" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" -H "Prefer: return=representation" \
  -d "{\"id\":\"$CID\",\"status\":\"rejected\",\"title\":\"E2E reopen fixture\",
       \"category\":\"safety\",\"trade\":\"Welder\",\"mentor_profile_id\":\"$MPID\",
       \"mentor_name\":\"E2E Test Mentor\",\"resolution_reason\":\"seeded for e2e reopen\",
       \"resolved_at\":\"$(date -u +%FT%TZ)\"}"
echo "$CID"   # note this id for the test plan + cleanup

# Cleanup (run unconditionally after the test):
curl -sS -X DELETE "$SUPABASE_URL/rest/v1/knowledge_candidates?id=eq.$CID" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```

> Fixtures that **restore** or **accept/merge** are more involved: the restore
> edge targets `topic:<trade>` verbatim, so the candidate's `trade` must match an
> existing topic hub (query `knowledge_nodes?id=like.topic:*` first — e.g.
> `Welder`, not `welding`) or restore 500s on an FK violation. Prefer the
> rejected-reopen fixture above unless you specifically need those paths.

## 4. Drive the flow (worked example: Reopen)

```
1. [New Context] Create a new browser context
2. [Clerk Auth] Sign in as {firstName: "E2E", lastName: "Admin", email: "jack-e2e-admin@example.com"}
3. [Browser] Open Knowledge Review, switch to the "Rejected" tab.
4. [Verify] The seeded candidate "E2E reopen fixture" is listed with a
   "Reopen for review" button.
5. [Browser] Click "Reopen for review".
6. [Verify] A success toast mentions "Pending"; the card leaves the Rejected tab.
7. [Browser] Switch to the "Pending" tab.
8. [Verify] "E2E reopen fixture" now appears under Pending.
```

The button label is **"Reopen for review"** for a rejected candidate and
**"Undo & reopen"** for an accepted/merged one; both call the same `reopen`
resolution and land the card back in Pending.
