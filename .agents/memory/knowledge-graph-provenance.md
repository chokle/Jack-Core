---
name: Atomic knowledge graph provenance
description: How distilled atomic-knowledge nodes attach to the Living Memory graph and the invariants that keep re-processing idempotent.
---

Atomic knowledge (concept/tool/hazard/etc.) lives in the same `knowledge_nodes`/`knowledge_edges` tables as the core/topic/competency/video scaffold, distinguished by node `kind`. A concept node's canonical id is `k:<category>:<normalized-title>`, so the same concept from any video collapses onto one shared node.

**Provenance is edge-owned, not node-owned.** A video→knowledge edge has `kind='knowledge'` and carries `{timestamps, confidence}` in edge `meta`. A concept "belongs to" a video only through this edge; the node itself is shared many-to-many.

**Invariants (violating any of these breaks idempotent re-processing):**
- The video-node structural edge reconciliation must NOT delete `kind='knowledge'` edges (it excludes them with `.neq("kind","knowledge")`). Those edges are owned by the distillation engine, so a plain metadata re-sync that does not re-run distillation must leave them intact.
- `syncVideoKnowledge` reconciles ONLY the current video's `kind='knowledge'` edges (delete source=videoNode & kind=knowledge, then reinsert). It must never touch another video's provenance edges, or the shared node's source list.
- Knowledge→topic / knowledge→competency edges are additive upserts (a growing many-to-many web); they are never bulk-deleted during a sync.
- Node merge is first-writer-wins for label/trade, monotonic-max for confidence, and preserves a human `verification_status` of `verified`/`rejected` (only defaults new nodes to `unverified`). Confidence recomputation / fuzzy-semantic dedup is deliberately a separate Graph Intelligence concern, not the distiller's.
- `pruneOrphanKnowledge` deletes any atomic-category node with zero incoming `kind='knowledge'` edges. Call it at the end of `syncVideoKnowledge`, in `removeVideoGraph`, and in `rebuildGraph` — but NEVER mid-sync (there is a delete→reinsert window where a node legitimately has zero edges).

**Why:** the API uses the Supabase service-role key and has no auth, so the distillation engine runs pipeline-internal only (invoked from `runAnalysis` in videos.ts via a best-effort `distillGraphSafe`); there is no public graph-mutation route. A distillation failure must never downgrade a successfully transcribed/analyzed video.
