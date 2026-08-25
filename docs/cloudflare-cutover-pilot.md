# Pilot001 Cloudflare Cutover

Canonical goal: #49 steps 1 and 11.

## Architecture

`jack.torchlabs.ca` -> Cloudflare Worker -> one named Cloudflare Container -> existing Jack Node/Express app -> Supabase.

This preserves the current long-lived job, feedback-notification, telemetry-retention, and vitality loops during the pilot. Supabase remains the data/backend layer. Railway is not removed until the Cloudflare deployment passes acceptance.

## Pre-cutover verification

1. Export the current production values from Railway. Do not commit them.
2. Set `VITE_CLERK_PUBLISHABLE_KEY` in the shell and generate a deployment config:

   ```bash
   VITE_CLERK_PUBLISHABLE_KEY='pk_live_...' node cloudflare/generate-deploy-config.mjs
   ```

3. Authenticate Wrangler and set runtime secrets against the generated config:

   ```bash
   npx wrangler whoami
   npx wrangler secret put CLERK_SECRET_KEY --config cloudflare/wrangler.generated.json
   npx wrangler secret put SUPABASE_URL --config cloudflare/wrangler.generated.json
   npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --config cloudflare/wrangler.generated.json
   npx wrangler secret put SUPABASE_DB_URL --config cloudflare/wrangler.generated.json
   npx wrangler secret put OPENAI_API_KEY --config cloudflare/wrangler.generated.json
   npx wrangler secret put RESEND_API_KEY --config cloudflare/wrangler.generated.json
   npx wrangler secret put ADMIN_EMAILS --config cloudflare/wrangler.generated.json
   npx wrangler secret put FEEDBACK_FROM_EMAIL --config cloudflare/wrangler.generated.json
   npx wrangler secret put FEEDBACK_NOTIFICATION_RECIPIENTS --config cloudflare/wrangler.generated.json
   ```

4. Deploy to the temporary `workers.dev` hostname first:

   ```bash
   npx wrangler deploy --config cloudflare/wrangler.generated.json
   ```

5. Verify the temporary hostname before touching `jack.torchlabs.ca`:
   - public application shell loads
   - `/api/healthz` responds
   - unauthenticated protected API routes remain denied
   - approved pilot sign-in works
   - Ask Jack returns a cited answer
   - Library and Living Memory load
   - telemetry event + EOD closeout write successfully
   - background worker heartbeat/sweeps resume in production Supabase logs

## Production cutover

Only after the temporary deployment passes, bind `jack.torchlabs.ca` to the Worker in Cloudflare. Re-run the same acceptance set on the production hostname.

Do not delete `railway.json`, Railway environment values, or Railway routing until the Cloudflare production hostname has passed acceptance and the background-worker heartbeat is confirmed.

## Post-cutover

1. Seed the deterministic Pilot001 knowledge through the embedding-backed seed path; never direct-SQL the knowledge rows.
2. Verify all 13 deterministic entries exist, especially Rob's 8 Pilot001 site-specific entries, and verify retrieval.
3. Complete the six-person Clerk/Command Centre reconciliation.
4. Close/supersede stale Railway deployment artifacts only after production verification.
