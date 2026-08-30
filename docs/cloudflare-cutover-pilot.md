# Pilot001 Cloudflare Cutover

Canonical goal: #49 steps 1 and 11.

## Architecture

`jack.torchlabs.ca` -> Cloudflare Worker -> one named Cloudflare Container -> existing Jack Node/Express app -> Supabase.

The Worker uses Cloudflare's supported `@cloudflare/containers` `Container` class for process startup, port-8080 readiness, request forwarding, and idle shutdown. This preserves the current long-lived job, feedback-notification, telemetry-retention, and vitality loops during the pilot. Supabase remains the data/backend layer. Railway is not removed until the Cloudflare deployment passes acceptance.

## Authentication boundary

This cutover uses Wrangler to deploy a Worker + Container. A `cloudflared.exe service install <TUNNEL_TOKEN>` command is for Cloudflare Tunnel and is **not** part of this production architecture.

The GitHub production deploy lane requires these repository Actions secrets:

- `CLOUDFLARE_API_TOKEN`
- `VITE_CLERK_PUBLISHABLE_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `CLERK_SECRET_KEY`
- `OPENAI_API_KEY`
- `ADMIN_EMAILS`

`CLOUDFLARE_ACCOUNT_ID` is an optional override, not a required handoff. If it is absent, the workflow resolves account context from the `torchlabs.ca` zone ownership and falls back to a single token-visible account or a unique Torch-named account. Resolution fails closed if the token can see multiple ambiguous accounts.

For a local manual run, Cloudflare account values can still be supplied explicitly:

```bash
CLOUDFLARE_API_TOKEN='...' CLOUDFLARE_ACCOUNT_ID='...' npx wrangler@4.127.1 whoami
```

Never commit credential material.

## Runtime secrets

Production runtime secrets are stored as GitHub Actions secrets and exposed only to the specific preflight and secret-handoff steps that need them. The workflow writes a mode-`0600` temporary JSON file on the ephemeral runner, passes it to Wrangler's `--secrets-file` option, and never commits or exposes the values job-wide. After deployment, Cloudflare stores them as encrypted Worker secret bindings and forwards them into the Container environment at startup.

The Pilot001 Cloudflare production path requires Clerk authentication. `VITE_CLERK_PUBLISHABLE_KEY` is provided to the production build through GitHub Actions, while `CLERK_SECRET_KEY` is delivered as an encrypted Cloudflare runtime secret. The build and runtime fail closed unless both sides are configured. The shared pilot auth bypass is test-only and must never be enabled for a production deployment.

## Automated temporary-host deployment

`.github/workflows/cloudflare-production-deploy.yml` runs on `main` and can also be dispatched manually. It performs the critical path as one fail-closed batch:

1. install with the frozen lockfile;
2. require all deployment/build/runtime credential handoffs;
3. resolve Cloudflare account context automatically unless the optional override exists;
4. verify Wrangler authentication;
5. generate and validate the deployment config;
6. run formatting, Wrangler dry-run, Container build, full API and Jack tests, workspace typecheck/build, and diff checks;
7. hand runtime secrets to Wrangler without exposing them job-wide;
8. deploy Worker + Container to the temporary `workers.dev` target;
9. resolve the deployed target/version from Wrangler structured output;
10. run 120 primary attempts, admitting terminal reconciliation only from an exact active/ready application digest plus warmup `200` and exactly one stopped `jack-production` instance whose non-empty ID/version matches the application;
11. pin the admitted application ID/digest/version and instance ID/version, require a fresh transition to `running` by 33:00 on a monotonic clock, then finish the complete acceptance transaction by the internal 34:30 deadline (inside the 35-minute step timeout);
12. re-prove the pinned application and serving instance before and after checking public shell `200`, `/api/healthz` `200` with `status=ok`, and anonymous `/api/me` exact `401` with the sign-in-required body; every Wrangler subprocess, HTTP probe, and poll sleep is bounded, and any identity/digest/version drift fails closed;
13. record deployment evidence in the workflow summary.

Production DNS remains unchanged during this lane so Railway stays available as rollback.
The production and verification workflows pin Wrangler `4.127.1`; do not replace that pin with `latest` during the pilot.

## Production cutover

Only after the temporary `workers.dev` deployment passes acceptance, bind `jack.torchlabs.ca` to the accepted Worker and repeat the acceptance set on the production hostname:

- public application shell loads;
- `/api/healthz` responds;
- approved Pilot001 access works through Clerk authentication;
- anonymous `/api/me` remains rejected;
- Ask Jack returns a cited answer;
- Library and Living Memory load;
- telemetry event + EOD closeout write successfully;
- background worker heartbeat/sweeps are visible in production Supabase logs.

Do not delete `railway.json`, Railway environment values, or Railway routing until Cloudflare production acceptance and the background-worker heartbeat are confirmed.

## Post-cutover

1. Verify all 13 deterministic entries exist, especially Rob's eight Pilot001 site-specific entries (`0006`-`0013`), and verify retrieval.
2. Complete the six-person account/Command Centre reconciliation.
3. Run full Pilot001 E2E/EOD acceptance and export closeout evidence.
4. Close or supersede stale Railway deployment artifacts only after production verification.
