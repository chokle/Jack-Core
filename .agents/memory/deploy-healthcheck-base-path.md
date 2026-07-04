---
name: Deployment healthcheck pings the service base path
description: Why the API service base path (bare /api) must return a shallow 200, and why liveness must stay DB-free.
---

# Deployment healthcheck hits the service base path, not /healthz

The platform/uptime healthcheck for the api-server deployment pings the service
BASE path — bare `/api` — even though `artifact.toml` sets the startup health
path to `/api/healthz`. Express mounts the router at `/api` with only sub-paths
defined, so bare `/api` returned 404 (and a transient 500 during cold-start
before the port was listening). A healthcheck that never returns 2xx reads as an
outage to uptime monitors and can drive restart loops, even while the app is
otherwise healthy and serving real traffic.

**Rule:** the API service base path (`GET /api`) must return a shallow 200. The
health router serves the same `{status:"ok"}` at both `/` and `/healthz`.

**Why shallow (no DB / OpenAI):** a liveness probe answers "is the process
serving HTTP", not "is Supabase reachable". A deep dependency check would turn
every transient Supabase blip into a platform-perceived outage / restart loop —
the exact failure class this fixes. Deep dependency visibility belongs in a
SEPARATE readiness/diagnostics endpoint (e.g. the pending Systems Health
heartbeat), never in the path the platform uses to decide restarts.

**How to apply:** keep `GET /` on the health router returning a static 200;
never add a DB/OpenAI call to it. Adding it to openapi.yaml is unnecessary — it
is an infra alias of the documented `/healthz`, same `HealthCheckResponse`, no
generated client ever calls it. Production must be REDEPLOYED for a health-route
change to take effect (the old build still 404s on `/api`).
