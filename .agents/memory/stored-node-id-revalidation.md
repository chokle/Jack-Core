---
name: Stored node ids are hints
description: Deferred workflows that store knowledge-graph node ids must re-validate them at action time, not trust them.
---

**Rule:** Any workflow that records a knowledge-graph node id for later action (review queues, scheduled jobs, saved links) must re-validate that id against the live graph inside the serialized action path before writing.

**Why:** The graph legitimately moves while work is deferred — video deletion, mentor withdrawal, and re-processing merges all remove or collapse nodes. Acting on a stale id either fails opaquely or resurrects a zombie node.

**How to apply:** Follow the escalation ladder: (1) id still live → use as-is; (2) id appears in a survivor's `meta.mergedFrom` ledger → follow the redirect (multi-entry ledgers make chains single-hop); (3) no trail → re-match by the item's own content using the SAME duplicate-smart signals as ingestion (never a parallel matcher); (4) nothing confident → return a structured refusal carrying fresh near matches and leave the record pending. Record requested-vs-actual target + a redirect reason so replays can match either id and stay idempotent.
