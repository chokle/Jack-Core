# Jack Core Railway Migration Pilot

Purpose: move Jack toward GitHub-owned deployment without interrupting beta users. This is infrastructure stabilization only; no feature work during the migration.

## Guardrails

- Keep Replit live for testers during the pilot.
- Do not switch `jack.torchlabs.ca` until QA passes on the Railway temporary URL.
- Keep Replit usable as rollback for one full week after DNS cutover.
- Target Railway spend: `$5-$20/month`.
- Stop and review before adding any paid service beyond the single Railway app service.
- Alert/approval threshold: projected Railway usage above `$25/month`.

## Railway Shape

Start with one Railway service:

- Build React frontend.
- Build Node/Express API.
- Start API server.
- API serves `/api/*`.
- API serves the built frontend for all non-API routes.
- Supabase Pro remains the database, storage, and pgvector backend.
- Clerk remains auth.
- Cloudflare remains DNS/SSL/security only.

## Required Railway Variables

Copy values from the current Replit/Supabase/Clerk setup. Do not paste secrets into commits.

```text
NODE_ENV=production
BASE_PATH=/
PUBLIC_SITE_URL=https://jack.torchlabs.ca
VITE_CLERK_PUBLISHABLE_KEY=...
VITE_DISABLE_CLERK_PROXY=true
CLERK_PUBLISHABLE_KEY=...
CLERK_SECRET_KEY=...
ADMIN_EMAILS=...
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_DB_URL=...
OPENAI_API_KEY=...
```

Railway provides `PORT`; do not hardcode it in service variables.

## Deploy Steps

1. Create a Railway project from `chokle/Jack-Core`.
2. Use the repo root as the service root.
3. Let `railway.json` provide build/start/healthcheck settings.
4. Add required environment variables.
5. Deploy to the Railway temporary URL.
6. Do not attach `jack.torchlabs.ca` yet.

## QA Checklist

Run this on the Railway temporary URL before DNS cutover:

- Login works.
- Sign-up works.
- Ask Jack loads and replies.
- Ask Jack cites existing memory where expected.
- Supabase reads work: Library loads videos.
- Supabase writes work: create a safe test record or parked thought.
- pgvector retrieval works: semantic search/Ask Jack retrieval returns relevant context.
- File/storage access works: existing video URLs and thumbnails load.
- Upload path works with a small test video, or is intentionally deferred with a logged reason.
- Background worker runs and advances a test job.
- Memory Graph loads.
- Contributor nodes and attached uploads render.
- Mobile layout works for landing, login, Ask Jack, Library, and graph.
- No broken environment variables in logs.
- No secrets appear in browser HTML, JS, network responses, or logs.
- Replit production remains reachable as rollback.

## DNS Cutover

Only after QA passes:

1. Add Railway custom domain for `jack.torchlabs.ca`.
2. In Cloudflare, update only the `jack` record to Railway's requested target.
3. Keep records needed by Clerk/Replit documented before editing.
4. Leave Replit running untouched.
5. Verify:
   - `https://jack.torchlabs.ca/`
   - `https://jack.torchlabs.ca/api/healthz`
   - login/sign-up
   - Ask Jack
6. Keep Replit rollback for seven full days.

## Rollback

If Railway fails after DNS cutover:

1. Restore the previous Cloudflare `jack` record to the Replit target/records.
2. Confirm Replit custom domain is still attached.
3. Hard-refresh and test login.
4. Leave Railway deployed for diagnosis but stop routing production traffic to it.
