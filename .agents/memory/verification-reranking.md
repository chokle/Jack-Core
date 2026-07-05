---
name: Verification-driven retrieval reranking
description: How reviewer verify/reject decisions on distilled concepts influence Ask Jack + semantic search
---
Retrieval (search + chat) runs over `transcript_segments` via pgvector; those rows have no verification status. Human review lives on `knowledge_nodes.verification_status`. The only bridge is `artifacts/api-server/src/lib/verification-rerank.ts`: it maps a verified/rejected concept's `meta.sources[{videoId,timestamps}]` onto a retrieved segment by (videoId + time-window ±2s) overlap, then boosts verified-covered segments (+0.15, clamped) and drops rejected-only segments. Verified wins over rejected on the same segment.

**Why:** verification_status was intentionally left out of RAG until this task; the two data models (segments vs concept nodes) only connect through provenance timestamps.

**How to apply:** any change to how concepts record provenance timestamps, or any new retrieval path, must keep feeding through this reranker or reviewer decisions silently stop mattering. Concepts whose sources have empty `timestamps` cannot be tied to a segment and are ignored by design (precise over broad — never boost/suppress a whole video off one node). Coverage-load DB failures degrade to un-reranked retrieval; reranking is an enhancement, never a hard dependency of answering. `knowledge_entries` (field notes) carry no verification_status and are out of scope.
