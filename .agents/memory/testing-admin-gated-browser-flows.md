---
name: Testing admin-gated browser flows
description: Why the Playwright testing subagent can't sign into JACK_ADMIN_KEY-gated UI, and how to verify those flows instead.
---

The Playwright `runTest` subagent cannot be handed the admin password to sign into
admin-gated Knowledge Review UI (restore/rearchive, verify/reject, mentor withdrawal).

**Why:** `JACK_ADMIN_KEY` is a Replit *secret*, not a shared env var. The
`code_execution` sandbox can't read secret values (`viewEnvVars` returns the secret
as a boolean `true`, redacted), and `process.env` is not exposed there at all. Piping
the raw secret into a `runTest` test plan would leak it into the subagent transcript.
The bash tool *can* use `$JACK_ADMIN_KEY` (e.g. curl login) as long as it's never printed.

**How to apply:** Verify admin-gated flows in two complementary passes:
1. Playwright for the parts that need no secret — anonymous gating (read-only queue,
   "Sign in to review" gate, reviewer tabs/action buttons absent when signed out) and
   page health / no console errors.
2. The signed-in mutation loop through the real Express routes + live Supabase via
   curl, holding the secret only in the shell env: `POST /api/admin/login` (cookie jar)
   → `POST /api/graph/candidates/:id/resolve` with the action. This exercises the same
   server code the UI calls. Assert state via the authoritative tab listings
   (`GET /api/graph/candidates?status=...`) and the graph node (`knowledge_nodes`),
   not the resolve response body.

Note: the resolve endpoint returns the candidate **flattened at top level** (via
`ResolveKnowledgeCandidateResponse.parse(result.candidate)`) — read `.status`, not
`.candidate.status`.

To seed an archived candidate without running a full mentor withdrawal: insert a
`knowledge_candidates` row with id `arch:<k:concept:...>`, `status='archived'`, and
content fields (title/description/category/trade/confidence). Restore re-mints the
node from the snapshot even if the node doesn't currently exist; a sourceless restored
node is deleted on rearchive.
