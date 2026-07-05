---
name: Replit shared env vars land in tracked .replit
description: Why sensitive values (admin keys, tokens, credentials) must be secrets, never "shared" env vars, in a Replit repl.
---

# Shared env vars are committed; secrets are not

Setting an env var in the **shared** (or development/production) scope via `setEnvVars` writes it as PLAINTEXT into `.replit` under `[userenv.shared]`. `.replit` is tracked in git, so that value gets committed and shows up in code review / history.

Managed **secrets** (the encrypted store) are NOT written to `.replit`; at runtime they are still exposed as `process.env.X`, so code that reads `process.env.JACK_ADMIN_KEY` works identically whether the value is a shared env var or a secret.

**Rule:** any sensitive value — admin/gate keys, API tokens, connection strings, passwords — must be a SECRET (`requestEnvVar({requestType:"secret", ...})`), never a shared env var. Only non-sensitive config (PORT, feature flags, log levels) belongs in shared.

**Why:** an admin key was once stored as a shared env var whose value was a live Postgres/Supabase connection string. It committed into `.replit` and a code review correctly blocked it as a leaked credential.

**How to remediate a leaked shared value:**
1. `deleteEnvVars({keys:[K], environment:"shared"})` — removes it from `.replit`.
2. `requestEnvVar({requestType:"secret", keys:[K]})` — user re-provisions a FRESH value in the encrypted store (treat the old one as compromised).
3. Restart the service workflow AFTER the secret is set (a restart done before the secret exists starts the process without the key → admin login 401/unconfigured).
4. The old value still lives in prior commits — rotating the underlying credential (e.g. the DB password) and scrubbing git history are USER actions (history rewrite is destructive git → background task / user only).
