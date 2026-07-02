---
name: Knowledge-candidate restore/re-archive toggle
description: How the restore ⇄ re-archive candidate actions decide no-op vs conflict, and how re-archive re-evaluates provenance.
---

# Restore ⇄ re-archive toggle semantics

`restore` and `rearchive` are inverse Knowledge-Review actions on an `arch:<nodeId>` candidate row (archived ⇄ restored). Each is idempotent on its OWN terminal state and refuses other lifecycle states as a conflict:

- `restore`: archived → restored. Replay on `restored` = no-op success; any non-archived state = conflict.
- `rearchive`: restored → archived. Replay on `archived` = no-op success; any non-restored (e.g. pending/accepted) = conflict.

**Deliberate asymmetry:** re-archiving an `archived` row (withdrawn, never restored) is a NO-OP SUCCESS, not a conflict — `archived` is already re-archive's target end state. Do not "fix" this into a conflict; a test that expects conflict there is wrong (use a `pending` row to exercise the conflict path).

**Why:** the pair is a toggle, so an action landing on its own end state must converge, mirroring the graph write being idempotent and replay-safe (graph write BEFORE the compare-and-set status flip).

**How re-archive treats the graph node:** it re-evaluates like a mentor withdrawal — if the node gained a live `knowledge` provenance edge (a video/mentor re-taught it after restore) it is KEPT, only `meta.curated`/`restoredAt` are dropped and aggregates recomputed; otherwise the sourceless curated node is deleted (edges cascade) and the `arch:<nodeId>` row still preserves the content snapshot.
