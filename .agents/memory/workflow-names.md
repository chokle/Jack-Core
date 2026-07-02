---
name: Workflow names in this workspace
description: How to get the exact workflow names accepted by restart_workflow in this pnpm monorepo.
---

Workflow names here follow the pattern `artifacts/<dir>: <service title>` (e.g. `artifacts/api-server: API Server`, `artifacts/jack-core: web`) — NOT the artifact title or slug alone.

**Why:** guessing `API Server` or `api-server` fails with RUN_COMMAND_NOT_FOUND and wastes restart timeouts.

**How to apply:** call `listWorkflows()` in the code-execution sandbox first to get exact names, then `restart_workflow` with the full string.
