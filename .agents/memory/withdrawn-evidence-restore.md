---
name: Withdrawn-evidence "restore" is a dismiss, not a re-corroborate
description: Why acting on a concept's rejectedEvidence clears the note instead of re-adding the source.
---

Acting on a concept's `rejectedEvidence` entry (the Provenance panel action) clears
the reviewed note; it does NOT re-add the withdrawn source.

**Why:** A `rejectedEvidence` entry is recorded when a re-processed video stops
extracting a concept it once corroborated. The distilled source row that produced
that evidence is gone, so re-adding it would either fabricate data or simply be
re-withdrawn on the next re-process. A concept that still carries a
`rejectedEvidence` entry always has ≥1 other live source (it survived the prune),
so the concept is alive — only the trust note needs clearing.

**How to apply:** `restoreWithdrawnEvidence(nodeId, videoId)` filters the matching
entry out of node meta; it is an idempotent no-op if absent and returns null for a
missing/non-knowledge node. `recomputeKnowledgeAggregates` only ever FILTERS
`rejectedEvidence` (never re-adds), so the removal is durable across re-process.
Route is admin-gated (`requireAdminSession`), consistent with other reviewer actions.
