# Pilot001 Cloudflare Cutover

Canonical goal: #49 steps 1 and 11.

## Architecture

`jack.torchlabs.ca` -> Cloudflare Worker -> one named Cloudflare Container -> existing Jack Node/Express app -> Supabase.

This preserves the current long-lived job, feedback-notification, telemetry-retention, and vitality loops during the pilot. Supabase remains the data/backend layer. Railway is not removed until the Cloudflare deployment passes acceptance.

## Authentication boundary

This cutover uses Wrangler to deploy a Worker + Container. A `cloudflared.exe service install <TUNNEL_TOKEN>` command is for Cloudflare Tunnel and is **not** part of this production architecture.

The GitHub production deploy lane requires one credential secret:

- `CLOUDFLARE_API_TOKEN`

`CLOUDFLARE_ACCOUNT_ID` is an optional override, not a required handoff. If it is absent, the workflow resolves account context from the `torchlabs.ca` zone ownership and falls back to a single token-visible account or a unique Torch-named account. Resolution fails closed if the token can see multiple ambiguous accounts.

For a local manual run, both values can still be supplied explicitly:

```bash
CLOUDFLARE_API_TOKEN='...' CLOUDFLARE_ACCOUNT_ID='...' npx wrangler whoami
```

Never commit credential material.

## Runtime secrets

Encrypted production runtime secrets remain in Cloudflare and are not duplicated into GitHub Actions. The generated Wrangler config declares the required bindings so deployment fails closed if Cloudflare is missing any required runtime secret.

The Pilot001 Cloudflare production path requires Clerk authentication. The build and runtime fail closed unless the Clerk publishable and secret keys are configured. The shared pilot auth bypass is test-only and must never be enabled for a production deployment.

## Automated temporary-host deployment

`.github/workflows/cloudflare-production-deploy.yml` runs on `main` and can also be dispatched manually. It performs the critical path as one fail-closed batch:

1. install with the frozen lockfile;
2. require `CLOUDFLARE_API_TOKEN`;
3. resolve Cloudflare account context automatically unless the optional override exists;
4. verify Wrangler authentication;
5. generate and validate the deployment config;
6. run formatting, Wrangler dry-run, Container build, full API and Jack tests, workspace typecheck/build, and diff checks;
7. deploy Worker + Container to the temporary `workers.dev` target;
8. resolve the deployed target/version from Wrangler structured output;
9. smoke-test the public shell, `/api/healthz`, and anonymous `/api/me` rejection;
10. record deployment evidence in the workflow summary.

Production DNS remains unchanged during this lane so Railway stays available as rollback.

## Production cutover

Only after the temporary `workers.dev` deployment passes acceptance, bind `jack.torchlabs.ca` to the accepted Worker and repeat the acceptance set on the production hostname:

- public application shell loads;
- `/api/healthz` responds;
- approved Pilot001 access works through the configured pilot auth path;
- Ask Jack returns a cited answer;
- Library and Living Memory load;
- telemetry event + EOD closeout write successfully;
- background worker heartbeat/sweeps are visible in production Supabase logs.

Do not delete `railway.json`, Railway environment values, or Railway routing until Cloudflare production acceptance and the background-worker heartbeat are confirmed.

## Post-cutover

1. Seed deterministic Pilot001 knowledge through the embedding-backed seed path; never direct-SQL the knowledge rows.
2. Verify all 13 deterministic entries exist, especially Rob's eight Pilot001 site-specific entries (`0006`-`0013`), and verify retrieval.
3. Complete the six-person account/Command Centre reconciliation.
4. Run full Pilot001 E2E/EOD acceptance and export closeout evidence.
5. Close or supersede stale Railway deployment artifacts only after production verification.
