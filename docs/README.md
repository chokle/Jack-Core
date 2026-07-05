# Jack — Documentation Index

`../replit.md` is the concise operating handbook and entry point (read it first, ~2–3 min). This folder holds the deep detail that used to live inline in `replit.md`.

Read order for a new agent: **`../VISION.md` (why + priorities) → `../JACK_CONSTITUTION.md` (answer rules) → `../replit.md` (how it's built) → these docs (deep detail).**

## Contents

- [architecture.md](./architecture.md) — stack and core architecture decisions (single-page model, persistence, video job pipeline lifecycle, strict knowledge-write verification, RAG-first answering, competency mapping).
- [knowledge-graph.md](./knowledge-graph.md) — Living Memory graph model, video/mentor ingestion bands, Knowledge Review resolution + drift resilience, Mentor Withdrawal, graph persistence & self-heal.
- [codebase-map.md](./codebase-map.md) — "where things live": file-by-file map of the API server and frontend.
- [product-features.md](./product-features.md) — product feature reference (Video Library, Ask Jack, Interview Mode, Knowledge Review, Graph Health, Parking Lot, etc.).
- [operations.md](./operations.md) — run/operate commands, the required Supabase schema setup, and operational gotchas.
- [upload-scalability-design.md](./upload-scalability-design.md) — design-only notes on scaling the upload pipeline (trigger-gated; no implementation).

## Related root documents

- [../VISION.md](../VISION.md) — Torch mission, principles, and development priorities (the "why").
- [../JACK_CONSTITUTION.md](../JACK_CONSTITUTION.md) — hard rules for Jack's answering behavior.
- [../threat_model.md](../threat_model.md) — security-relevant architecture, assets, trust boundaries, and required guarantees.
