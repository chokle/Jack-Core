---
name: Reviewer identity in the admin request
description: How a signed-in reviewer's name is attached to verify/reject/resolve decisions in Jack, and why it comes from the server-resolved identity, not the body.
---

# Reviewer identity behind verified concepts

Jack's admin boundary is **Clerk email-role RBAC** (see `admin-auth.ts`): a caller
is an admin iff their Clerk-verified email is in the `ADMIN_EMAILS` allowlist
(fail-closed — unset allowlist ⇒ nobody is admin). `requireAdmin` resolves the
caller server-side (`getAuth(req).userId` → `clerkClient.users.getUser` →
`isAdminEmail`) and stashes `req.admin = {userId,email,name}`.

**Rule:** the reviewer name comes from that server-resolved identity via
`getAdminReviewer(req)` (returns `req.admin.name ?? req.admin.email ?? null`) —
never from the request body.

**Why:** the API holds the Supabase service-role key and the body is fully
client-controlled. Taking the name from the body would let any caller spoof who
verified a concept. Resolving it from the Clerk session makes it non-spoofable.

**How to apply:**
- New gated writes that need attribution should call `getAdminReviewer(req)` and
  pass it down — do NOT add a `reviewer` field to any request body/OpenAPI schema.
- `verificationHistory` entries are `{from,to,at,reviewer}`; `reviewer` is `null`
  when the admin has no display name set on their Clerk profile (email fallback).
- Historical note: this used to be a shared-password HMAC-signed cookie
  (`jack_admin_session` keyed by `JACK_ADMIN_KEY`) with the reviewer name in the
  cookie payload. That whole password-session machinery was removed in the Clerk
  migration; `JACK_ADMIN_KEY`/`ADMIN_API_KEY` env vars may linger but are unused
  by the admin boundary.
