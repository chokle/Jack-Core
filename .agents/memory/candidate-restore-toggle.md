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

## `reopen` — undoes ANY resolved candidate (reject + accept + merge)

`reopen` returns a RESOLVED candidate → `pending` for a fresh decision. It reuses the exact replay/CAS shape: dispatches to its own inner handler before the generic pending path, replay on `pending` = no-op success, and refuses any NON-resolved state (e.g. `archived`/`restored`, which have their own restore/rearchive inverse) as conflict.

- **reject path:** side-effect-free — `reject` wrote NO graph edge, so flipping back to pending needs no graph reversal.
- **accept/merge path — undo is PER-ANSWER, not per-candidate:** accept/merge wrote an additive mentor→concept provenance edge, so reopen reverses it by dropping this answer's contribution (dedup key = the mentor answer id, or the candidate id when unknown), decrementing the edge weight (= distinct answers) and only deleting the edge when its last answer leaves — then re-evaluating the survivor exactly like a mentor withdrawal does. So a concept the mentor corroborated across several answers keeps the edge minus this one, and confidence/hub-weights/verification reconverge honestly. This is why the old "reopen is rejected-ONLY" rule is dead.
- **Ordering & idempotency (durable rules):** the graph reversal MUST run before the status flip and every step MUST be idempotent (removing an already-absent answer, or acting on a vanished edge/target, is a no-op), so a mid-flight failure heals on a reopen retry. Prune before recompute (recompute skips vanished ids). Two facts that are easy to trip over: `knowledge_edges` has NO `updated_at` column (only `weight`+`meta` may be updated), and recompute never rewrites `kind='knowledge'` edge weights (only node aggregates + hub topic/competency weights) — so a per-answer weight decrement is stable.
- **Confidence recompute:** the mentor→concept edge now carries a per-answer ledger `meta.answerConfidences` (keyed by answerId, written on every accept/merge/reinforce). On a per-answer withdrawal that keeps the edge, `meta.confidence` is recomputed as the max over the SURVIVING answers' recorded confidences — so a withdrawn high-confidence answer no longer strands the edge over-confident. A LEGACY edge (pre-ledger) with any surviving answer whose confidence is unknown keeps its prior confidence (never understated). Aliases + `meta.mergedFrom` are still deliberately LEFT intact (unattributed alternate wordings, not mentor data).
- **Known granularity limit:** candidate ids embed the answer id, so ONE answer can spawn multiple candidates. If two same-answer candidates were resolved onto the SAME target, the edge carries that answer once (write-time dedup), so reopening either strips the whole answer's contribution while the sibling stays resolved pointing at a now-unbacked target. Symmetric with the write-time dedup, rare, and self-heals on re-accept — the undo is per-answer, not per-candidate.
- **Null-mentor STRAND guard:** a withdrawn mentor's resolved candidate is scrubbed (`mentor_profile_id` nulled). Reopening a scrubbed row would strand it — accept/merge later refuse a candidate with no mentor provenance, and a future withdrawal DELETEs a pending row instead of scrubbing. So reopen refuses `!mentorProfileId` up front with `invalid`, AND the CAS also filters `.not("mentor_profile_id","is",null)` to close the read→update scrub race; the frontend hides the Reopen button when `mentorProfileId` is null.
