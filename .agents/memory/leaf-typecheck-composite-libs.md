---
name: Leaf typecheck vs composite lib builds
description: Why a leaf artifact typecheck can fail with misleading "no exported member" errors, and how to make it self-contained.
---

Leaf artifacts (e.g. `artifacts/api-server`) reference composite libs (`lib/api-zod`, `lib/db`) via TS project references. A plain leaf `tsc -p tsconfig.json --noEmit` does NOT build those refs — it consumes their emitted `dist/*.d.ts`.

Symptoms when the lib `dist` is stale/missing:
- Stale dist (built before a new generated export existed): `Module '"@workspace/api-zod"' has no exported member 'X'` — looks like stale codegen but the tracked source is fine.
- Missing dist: `TS6305: Output file '.../dist/index.d.ts' has not been built from source`.

Root cause is build ordering, not codegen. The canonical root `pnpm run typecheck` passes because it runs `typecheck:libs` (`tsc --build`) first; the standalone leaf command fails in isolation.

`lib/*/dist` and `*.tsbuildinfo` are gitignored, so rebuilding does NOT produce a committable fix — it only heals the local cache and won't survive a merge.

**Fix that persists:** make the leaf `typecheck` build its lib refs first:
`"typecheck": "tsc --build ../../lib/api-zod ../../lib/db && tsc -p tsconfig.json --noEmit"`.
Incremental, so it's a fast no-op under the root gate (libs already built by `typecheck:libs`).

**Why:** `tsc --build --noEmit` doesn't work here — `--noEmit` propagates to the composite refs and throws `TS6310: Referenced project may not disable emit`. So build refs and noEmit-check the leaf as two steps.

**Note:** this diverges from the pnpm-workspace skill convention (leaf = plain `tsc -p tsconfig.json --noEmit`). Every artifact that references composite libs now builds its refs first: `api-server` builds `../../lib/api-zod ../../lib/db`, `jack-core` builds `../../lib/api-client-react`. `mockup-sandbox` has no composite-lib references (and imports no `@workspace/*` lib), so it keeps the plain script and is self-contained as-is. When adding a NEW artifact that imports a composite lib, give its `typecheck` the same `tsc --build <that lib> && tsc -p tsconfig.json --noEmit` shape.
