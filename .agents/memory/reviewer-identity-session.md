---
name: Reviewer identity in the admin session
description: How a signed-in reviewer's name is attached to verify/reject decisions in Jack, and why it rides in the session not the body.
---

# Reviewer identity behind verified concepts

Jack's admin boundary is a single shared-password HMAC-signed cookie
(`jack_admin_session`, keyed by `JACK_ADMIN_KEY`) — there is no per-user account
or user id. So a "reviewer" is a **self-declared display name** captured at login,
not an authenticated identity.

**Rule:** the reviewer name is encoded *inside* the signed session cookie
(base64url JSON payload `{v:"authenticated", reviewer}`), and the verification
route reads it from the session via `getAdminReviewer(req)` — never from the
request body.

**Why:** the API holds the Supabase service-role key and the body is fully
client-controlled. Taking the name from the body would let any caller spoof who
verified a concept. Signing it into the cookie makes it tamper-proof (altering the
payload breaks the HMAC → session invalid).

**How to apply:**
- New gated writes that need attribution should call `getAdminReviewer(req)` and
  pass it down — do not add a `reviewer` field to any request body/OpenAPI schema.
- `verificationHistory` entries are `{from,to,at,reviewer}`; `reviewer` is `null`
  for anonymous/legacy sessions (a valid session with no name is still allowed at
  the auth layer — the frontend login is what requires a name).
- The session cookie payload format changed from a bare `"authenticated"` string
  to base64url JSON. Old-format cookies fail decode and read as invalid — fine
  since sessions expire in 8h.
