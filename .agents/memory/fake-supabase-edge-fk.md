---
name: Fake supabase enforces knowledge_edges FK
description: The in-memory Supabase test double rejects edges pointing at missing nodes, mirroring the real FK.
---
The fake Supabase (`artifacts/api-server/src/lib/__tests__/fake-supabase.ts`) now enforces `knowledge_edges.source_id`/`target_id REFERENCES knowledge_nodes(id)` on upsert (edges are only ever written via upsert). An edge whose non-null endpoint id has no matching node row returns a `..._id_fkey ... is not present in table "knowledge_nodes"` error, just like production.

**Why:** A whole class of production 500s (writing an edge before its node) was invisible to the unit suite because the harness only modeled NOT NULL + ON DELETE CASCADE. A prior restore-path crash was fixed narrowly by asserting the re-minted hub exists; the harness FK check now guards every other graph-write path directly.

**How to apply:** In tests, seed the referenced knowledge_nodes rows before upserting edges that point at them (real graph paths already scaffold hubs first). NULL endpoints are left to the NOT NULL check, not the FK check. If a graph-write path starts failing this in tests, that is a real ordering bug (emit the node before the edge), not a harness problem.
