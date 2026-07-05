# Torch — Vision & Operating Manual

This is the operating manual for every AI agent (and human) working on Torch. It explains what we are building, why it matters, and the rules that govern implementation decisions. When a product or engineering choice is ambiguous, this document — together with `JACK_CONSTITUTION.md` (hard rules for Jack's behavior) and `replit.md` (architecture of record) — is the tie-breaker.

Read order for a new agent: **VISION.md (why + priorities) → JACK_CONSTITUTION.md (answer rules) → replit.md (how it's built).**

---

## 1. Torch Mission

Torch preserves hard-won skilled-trades knowledge and makes it instantly usable in the field.

Experienced tradespeople carry decades of field-tested judgment that never makes it into a manual. When they retire, it's gone. Apprentices, workers, and employers are left relearning the same lessons the hard way. Torch captures that knowledge from training videos and directly from mentors, structures it, and serves it back as trustworthy, cited answers — on a jobsite, on a phone, with gloves on.

**Torch is the platform. Jack is the intelligence inside it.** Every feature is judged by one question: *does this help a real worker do the job right and safely, faster than they could without it?*

---

## 2. Jack

Jack is the AI Trade Intelligence Engine — a searchable, queryable video knowledge library that answers trade questions with timestamp citations.

What Jack does:
- Transcribes training videos (Whisper) and indexes every segment for semantic search.
- Analyzes each video (GPT-4o): summaries, key points, and Red Seal competency mappings.
- Answers questions (Ask Jack) by searching the internal library **first**, then citing the exact videos and timestamps behind the answer.
- Surfaces related content by vector similarity.

Jack speaks like an experienced tradesperson, not a textbook. Practical field guidance over classroom language. See `JACK_CONSTITUTION.md` §6 (Voice and trust).

---

## 3. Teach Jack

Torch grows because people teach it, not just because videos are uploaded.

**Teach Jack** (Interview Mode) lets Jack conversationally interview an experienced tradesperson — one plainspoken, skippable question at a time. Answers are saved verbatim, then distilled through the **same** pipeline as videos and folded into the **same** shared knowledge graph as `mentor_supplied` corroboration.

Principles:
- Mentor input **corroborates**, it does not fragment. A mentor's wording collapses onto the canonical concept it matches (recorded as an alias) rather than minting a duplicate node.
- Mentor contributions carry provenance. Every concept knows which mentor(s) reinforced it, and that attribution can be honored or withdrawn on request (Mentor Withdrawal removes the person, never the community's knowledge).
- A human stays in the loop. Uncertain mentor concepts are queued for **Knowledge Review** (Accept / Merge / Reject) rather than silently entering the live graph.

---

## 4. Living Memory

Living Memory is Torch's persistent knowledge graph — the structured map of what Torch knows and how it connects.

- It is persisted in Supabase (`knowledge_nodes` / `knowledge_edges`) as a deterministic-ID mirror, so re-processing or merging collapses onto the same node instead of duplicating.
- Nodes: the core `JACK` hub, `topic:<trade>` hubs (the seeded Red Seal trades), `comp:<code>` competencies, `video:<uuid>` sources, and distilled concepts.
- Edges carry provenance and weight. A concept's trust and sourcing are **edge-owned**, so the same concept can be corroborated by many videos and mentors without fragmenting.
- Living Memory self-heals and can be rebuilt deterministically; the UI can fall back to a client-derived graph if the persisted graph is briefly unavailable.

Living Memory is the substance Torch accumulates over time. Protect its integrity above convenience.

---

## 5. Knowledge Principles

These govern how any new knowledge enters Torch. Violating them corrupts the graph for everyone.

1. **One concept, one canonical node.** Before minting a node, run the duplicate-smart signals in order: exact deterministic id → cross-category label+alias index → same-category semantic match (≥ 0.85). A match reinforces the existing node; the new wording becomes an alias (deduped, capped).
2. **Provenance is edge-owned, never node-owned.** Corroboration adds/strengthens edges; it does not overwrite the concept. This is what lets mentors and videos reinforce the same truth.
3. **Reinforcement-first for mentors, with a review band.** Mentor concepts: strong match → reinforce; middle band (0.70–0.85) → **queue** in `knowledge_candidates` for human review; below 0.70 → create. Videos deliberately have **no** queue band — a middle-band video concept creates a node immediately, because Ask Jack citations and search must reference it the moment the video is processed.
4. **Every stage is idempotent.** Re-processing, replays, and retries must converge to the same graph. Deterministic IDs and delete-then-insert / overwrite semantics are non-negotiable.
5. **Reviews are resilient to graph drift.** A recorded best-match id is a hint, not a guarantee — always re-validate a resolution target against the live graph before writing (follow merge ledgers; re-match by content if it vanished).
6. **Withdrawal removes the person, not the knowledge.** Concepts with surviving evidence are retained (aggregates recomputed); mentor-only concepts are archived (restorable), never silently deleted.

Deeper mechanics live in `docs/architecture.md` and `docs/knowledge-graph.md` (indexed from `replit.md`) — keep those files authoritative for the how; keep this list authoritative for the why.

---

## 6. The 30-Second Field UX Rule

Torch is used on jobsites, one-handed, on a phone, sometimes with gloves and poor signal. If a worker cannot get a usable answer in **about 30 seconds**, the feature has failed — no matter how good the underlying intelligence is.

Rules for any field-facing surface:
- **Answer in one screen.** The core answer + its citation must be visible without scrolling or extra taps. Elaboration can come after.
- **Minimize taps to an answer.** Ask → answer should be the shortest path in the app. Don't gate field answers behind navigation, setup, or logins.
- **Big targets, high contrast, forgiving input.** Assume gloves, sunlight, and typos. Voice and short queries must work.
- **Fast or honest.** Show progress immediately; never a frozen screen. If retrieval is slow, say so.
- **Degrade gracefully offline/low-signal.** Prefer partial, cited answers over spinners that never resolve.

When a design decision trades depth for speed on a field surface, choose speed. Depth belongs on the review/admin surfaces, not in a worker's hand at height.

---

## 7. Trust & Anti-Hallucination Rules

Trust is the product. A confident wrong answer is worse than "I don't know." These are enforced by `JACK_CONSTITUTION.md`; the essentials:

- **Search internal knowledge first.** Jack always queries the Torch library (pgvector RAG) before answering. Responses carry `usedInternalKnowledge` — `false` means no matching internal segments were found, and the answer must say so.
- **Follow the source hierarchy:** Torch-verified library knowledge → uploaded company docs/procedures → trusted external references (only when internal is insufficient) → ask a clarifying question when confidence is low. Always make clear which tier an answer came from.
- **Cite everything citable.** Timestamps, source videos, documents, or an explicit confidence level. No generic textbook answers when field context matters.
- **Label the kind of knowledge:** code/procedure requirement vs. company practice vs. mentor opinion vs. regional slang vs. general field experience.
- **Ask before assuming.** For slang, nicknames, regional terms, or multiple reasonable interpretations, ask a clarifying question rather than guessing.
- **Verified knowledge should weigh more.** Corroborated, human-verified, well-sourced concepts should be trusted over thinly-sourced ones. Never let a single unverified voice masquerade as settled fact.
- **Safety is non-negotiable.** Never replace site procedures, engineered drawings, WPS/WPDS, JHAs, manufacturer instructions, or supervisor direction. Flag high-risk work and point to the applicable procedure or a qualified person.

If Jack cannot increase trust with an answer, it must ask a better question instead of giving a weaker answer.

---

## 8. Multilingual Workforce Safety

Canada's construction workforce is multilingual. Many workers are highly competent in their trade but face safety risks when critical jobsite instructions are only available in English.

- Torch supports **language-independent knowledge access**. A worker should be able to ask Jack in their strongest language and receive a clear, safety-conscious answer.
- **Preserve key jobsite terms in English.** Safety-critical and regulated terminology (equipment names, procedure codes, sign-off language) must remain unambiguous across the crew.
- Torch **bridges** language gaps; it does not replace site procedures, supervision, or required workplace communication standards.

Core principle: **a language barrier should not erase a worker's skill or put them in danger.**

---

## 9. Development Priorities

Ship customer-demo-ready value first. This is the order of importance when sequencing work (from `JACK_CONSTITUTION.md` §7, extended):

**Core pipeline (must always work):**
1. Upload video
2. Transcribe video
3. Create embeddings
4. Ask Jack
5. Timestamped answers
6. Competency tags
7. Persistent knowledge nodes (Living Memory)

**Then, in service of the mission:**
8. Teach Jack (mentor Interview Mode) and Knowledge Review
9. Trust surfacing — provenance, verification, and weighting verified knowledge in answers
10. Field UX — deliver on the 30-second rule on real phones
11. Multilingual access

**Standing rules for prioritization:**
- Protect the core pipeline before adding new surfaces. A regression in upload → Ask Jack outranks any new feature.
- Protect Living Memory's integrity over shipping speed. Never trade idempotency or provenance for a quick win.
- Prefer functional software with real data over mocks and silent fallbacks; fail loudly and honestly.
- Every feature must earn its place against the mission test in §1.
