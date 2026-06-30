---
name: Supabase connectivity from Replit
description: Why the Supabase direct DB host fails from Replit and how to reach it via the IPv4 session pooler (incl. region discovery).
---

# Supabase DB connectivity from the Replit environment

The Replit container is **IPv4-only**. Supabase's **direct** DB host
`db.<ref>.supabase.co` publishes **only an AAAA (IPv6) record**, so any `pg`
connection to it fails with `ENOTFOUND` / `EAFNOSUPPORT`. This is not a code bug —
it is an environment constraint.

**Rule:** for DDL/schema setup against Supabase from Replit, use the **session
pooler** (IPv4), not the direct host and not the *transaction* pooler (transaction
mode can't run DDL).

- Session pooler host: `aws-<N>-<region>.pooler.supabase.com:5432`
  (the `<N>` prefix is `aws-0` or `aws-1` depending on the project)
- Username becomes `postgres.<ref>` (not plain `postgres`)
- `ssl: { rejectUnauthorized: false }`

**Why:** the Supabase JS/REST client cannot run DDL, so schema setup needs a real
Postgres connection — and the only reachable one from Replit is the session pooler.

## Discovering the region/prefix when only the direct URL is known
Probe `aws-{0,1}-<region>.pooler.supabase.com` with user `postgres.<ref>`:
- `XX000` ("Tenant or user not found") = **wrong region/prefix** — keep scanning.
- `28P01` ("invalid password") = **correct region/prefix reached**, only the
  password is wrong. This positively identifies the project's region.

## Common user copy-paste trap
Supabase shows `[YOUR-PASSWORD]` as a placeholder. Users frequently paste the
connection string keeping the **literal square brackets** (e.g. password stored as
`[secret]` instead of `secret`). Strip a single wrapping `[...]` pair before use; if
`28P01` persists after stripping, the password is genuinely wrong (ask them to reset
it in Dashboard → Project Settings → Database).

## Reliable fallback
If no working pooler credential is available, apply the canonical SQL manually:
paste `scripts/src/supabase-schema.sql` into Supabase Dashboard → SQL Editor → Run.
No DB password needed (uses the dashboard session). Verify afterward over HTTPS via
the supabase-js REST client (works fine on IPv4) or by curling the API endpoints.
