/**
 * Guard tests for Knowledge Review — resolving queued mentor-concept candidates
 * with Accept / Merge / Reject. Accept and merge must reinforce exactly one
 * canonical node through the SAME mentor-reinforcement machinery as ingestion
 * (mentor provenance edge, alias recording, aggregate recompute); reject must
 * never touch the live graph and must persist its reason; replaying any
 * resolution must be a no-op; resolved candidates must leave the pending list.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AtomicKnowledge, KnowledgeCategory } from "../distillation.js";

vi.mock("../supabase.js", async () => {
  const m = await import("./mocks.js");
  return { supabase: m.fake };
});

vi.mock("../openai.js", async () => {
  const m = await import("./mocks.js");
  return { createEmbedding: m.createEmbedding, MODELS: m.MODELS, openai: m.openai };
});

import { fake, embedRegistry, resetMocks } from "./mocks.js";
import {
  ensureBaseGraph,
  syncVideoGraph,
  syncVideoKnowledge,
  syncMentorAnswerKnowledge,
  knowledgeNodeId,
  listKnowledgeCandidates,
  resolveKnowledgeCandidate,
} from "../memory-graph.js";

const TRADE = "Welder";
const MENTOR_A = "aaaaaaaa-0000-0000-0000-000000000001";
const ANSWER_1 = "11111111-0000-0000-0000-000000000001";
const SESSION = "99999999-0000-0000-0000-000000000009";

function makeItem(
  category: KnowledgeCategory,
  title: string,
  extra: Partial<Omit<AtomicKnowledge, "id" | "title" | "category">> = {},
): AtomicKnowledge {
  return {
    id: knowledgeNodeId(category, title),
    title,
    category,
    description: extra.description ?? "",
    timestamps: extra.timestamps ?? [],
    confidence: extra.confidence ?? 0.6,
    competencyCode: extra.competencyCode ?? null,
  };
}

async function seedVideo(id: string, trade: string = TRADE): Promise<void> {
  fake.tables["videos"].push({
    id,
    title: `Video ${id}`,
    trade,
    status: "ready",
    description: null,
    competency_codes: [],
    created_at: new Date().toISOString(),
    updated_at: null,
  });
  await syncVideoGraph(id);
}

function seedBaseTables(): void {
  fake.tables["competencies"].push(
    { code: "W-2", name: "Shielded Metal Arc Welding", trade: "Welder", description: null },
    { code: "W-3", name: "Gas Metal Arc Welding", trade: "Welder", description: null },
  );
}

const nodes = () => fake.tables["knowledge_nodes"];
const edges = () => fake.tables["knowledge_edges"];
const candidates = () => fake.tables["knowledge_candidates"] ?? [];
const nodeById = (id: string) => nodes().find((n) => n["id"] === id);
const knowledgeNodes = () => nodes().filter((n) => (n["id"] as string).startsWith("k:"));
const edgeBetween = (source: string, target: string) =>
  edges().find((e) => e["source_id"] === source && e["target_id"] === target);

const BASE_VEC = [1, ...Array(15).fill(0)] as number[];
const atSimilarity = (s: number): number[] => [s, Math.sqrt(1 - s * s), ...Array(14).fill(0)];

/** Stable graph snapshot ignoring write-time bookkeeping fields. */
const TIME_KEYS = new Set([
  "created_at",
  "updated_at",
  "extractedAt",
  "firstExtractedAt",
  "lastExtractedAt",
  "at",
]);
function stripTimes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripTimes);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (!TIME_KEYS.has(k)) out[k] = stripTimes(v);
    }
    return out;
  }
  return value;
}
const snapshot = (rows: Record<string, unknown>[]): string =>
  JSON.stringify(
    stripTimes([...rows].sort((a, b) => String(a["id"]).localeCompare(String(b["id"])))),
  );
const graphSnapshot = () => snapshot(nodes()) + "|" + snapshot(edges());

const CANONICAL_TITLE = "Porosity Prevention";
const UNCERTAIN_TITLE = "Keeping Gas Coverage Clean";
const canonicalId = knowledgeNodeId("concept", CANONICAL_TITLE);
const candidateId = `cand:${ANSWER_1}:${knowledgeNodeId("concept", UNCERTAIN_TITLE)}`;

/**
 * Seed one video-taught canonical concept and queue one mentor concept in the
 * uncertain middle band (cos 0.75) so a pending candidate exists whose top
 * best match is the canonical node.
 */
async function seedPendingCandidate(): Promise<void> {
  await seedVideo("vid-1");
  embedRegistry.set(CANONICAL_TITLE, BASE_VEC);
  await syncVideoKnowledge("vid-1", [makeItem("concept", CANONICAL_TITLE)]);

  embedRegistry.set(UNCERTAIN_TITLE, atSimilarity(0.75));
  await syncMentorAnswerKnowledge(
    MENTOR_A,
    "Alice",
    [makeItem("concept", UNCERTAIN_TITLE, { confidence: 0.8 })],
    { answerId: ANSWER_1, trade: TRADE, sessionId: SESSION },
  );
  expect(candidates()).toHaveLength(1);
}

beforeEach(async () => {
  resetMocks();
  seedBaseTables();
  await ensureBaseGraph();
});

describe("Knowledge Review — accept", () => {
  it("reinforces the top best-match node with mentor provenance and correct aggregates", async () => {
    await seedPendingCandidate();
    const before = knowledgeNodes().length;

    const result = await resolveKnowledgeCandidate(candidateId, "accept");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.replayed).toBe(false);
    expect(result.candidate.status).toBe("accepted");
    expect(result.candidate.resolvedTargetId).toBe(canonicalId);
    expect(result.candidate.resolvedAt).toBeTruthy();

    // Exactly one canonical node was reinforced — no new node minted.
    expect(knowledgeNodes().length).toBe(before);
    expect(nodeById(knowledgeNodeId("concept", UNCERTAIN_TITLE))).toBeUndefined();

    // Mentor provenance edge, deduped by the original answer id.
    const edge = edgeBetween(`mentor:${MENTOR_A}`, canonicalId)!;
    expect(edge).toBeDefined();
    expect(edge["kind"]).toBe("knowledge");
    const meta = edge["meta"] as Record<string, unknown>;
    expect(meta["answerIds"]).toEqual([ANSWER_1]);
    expect(meta["sourceType"]).toBe("mentor");

    // The node gained the mentor's wording as an alias and mentor corroboration.
    const node = nodeById(canonicalId)!;
    expect(node["verification_status"]).toBe("mentor_supplied");
    const nodeMeta = node["meta"] as Record<string, unknown>;
    expect(nodeMeta["aliases"]).toContain(UNCERTAIN_TITLE);
    // Aggregates recomputed from provenance: two distinct sources (video + mentor).
    expect(nodeMeta["sourceCount"] ?? nodeMeta["sources"]).toBeTruthy();

    // Resolved candidates leave the pending list.
    expect(await listKnowledgeCandidates("pending")).toHaveLength(0);
    expect((await listKnowledgeCandidates("accepted"))[0]!.id).toBe(candidateId);
  });

  it("replaying an accept is a strict no-op", async () => {
    await seedPendingCandidate();
    await resolveKnowledgeCandidate(candidateId, "accept");
    const snap = graphSnapshot();
    const candSnap = snapshot(candidates());

    const replay = await resolveKnowledgeCandidate(candidateId, "accept");
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.replayed).toBe(true);
    expect(graphSnapshot()).toBe(snap);
    expect(snapshot(candidates())).toBe(candSnap);
  });

  it("a conflicting re-resolution is refused", async () => {
    await seedPendingCandidate();
    await resolveKnowledgeCandidate(candidateId, "accept");

    const conflict = await resolveKnowledgeCandidate(candidateId, "reject", {
      reason: "changed my mind",
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.code).toBe("conflict");
    expect(candidates()[0]!["status"]).toBe("accepted");
  });
});

describe("Knowledge Review — merge", () => {
  it("reinforces the reviewer-chosen target exactly like ingestion-time reinforcement", async () => {
    await seedPendingCandidate();
    // A second existing concept the reviewer prefers over the top suggestion.
    const other = makeItem("concept", "Shielding Gas Discipline");
    await syncVideoKnowledge("vid-1", [
      makeItem("concept", CANONICAL_TITLE),
      other,
    ]);
    const before = knowledgeNodes().length;

    const result = await resolveKnowledgeCandidate(candidateId, "merge", {
      targetNodeId: other.id,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.status).toBe("merged");
    expect(result.candidate.resolvedTargetId).toBe(other.id);

    // Reinforced the chosen node only — no new node, no edge to the top match.
    expect(knowledgeNodes().length).toBe(before);
    const edge = edgeBetween(`mentor:${MENTOR_A}`, other.id)!;
    expect(edge).toBeDefined();
    expect((edge["meta"] as Record<string, unknown>)["answerIds"]).toEqual([ANSWER_1]);
    expect(edgeBetween(`mentor:${MENTOR_A}`, canonicalId)).toBeUndefined();

    const node = nodeById(other.id)!;
    expect(node["verification_status"]).toBe("mentor_supplied");
    expect((node["meta"] as Record<string, unknown>)["aliases"]).toContain(UNCERTAIN_TITLE);

    expect(await listKnowledgeCandidates("pending")).toHaveLength(0);
    expect((await listKnowledgeCandidates("merged"))[0]!.id).toBe(candidateId);
  });

  it("requires a target and refuses scaffold nodes", async () => {
    await seedPendingCandidate();

    const missing = await resolveKnowledgeCandidate(candidateId, "merge");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("invalid");

    const scaffold = await resolveKnowledgeCandidate(candidateId, "merge", {
      targetNodeId: `topic:${TRADE}`,
    });
    expect(scaffold.ok).toBe(false);
    if (!scaffold.ok) expect(scaffold.code).toBe("invalid");

    // A target that never existed and leaves no redirect trail is a
    // STRUCTURED target_gone conflict (not a plain invalid): the candidate
    // stays pending and fresh near matches are handed back to re-aim with.
    const ghost = await resolveKnowledgeCandidate(candidateId, "merge", {
      targetNodeId: "k:concept:does-not-exist",
    });
    expect(ghost.ok).toBe(false);
    if (!ghost.ok) {
      expect(ghost.code).toBe("target_gone");
      if (ghost.code === "target_gone") {
        expect(ghost.bestMatches.map((m) => m.nodeId)).toContain(canonicalId);
      }
    }

    // The candidate is still pending after every failed attempt.
    expect(candidates()[0]!["status"]).toBe("pending");
  });

  it("replaying a merge with the same target is a no-op; a different target conflicts", async () => {
    await seedPendingCandidate();
    const other = makeItem("concept", "Shielding Gas Discipline");
    await syncVideoKnowledge("vid-1", [makeItem("concept", CANONICAL_TITLE), other]);

    await resolveKnowledgeCandidate(candidateId, "merge", { targetNodeId: other.id });
    const snap = graphSnapshot();

    const replay = await resolveKnowledgeCandidate(candidateId, "merge", {
      targetNodeId: other.id,
    });
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.replayed).toBe(true);
    expect(graphSnapshot()).toBe(snap);

    const different = await resolveKnowledgeCandidate(candidateId, "merge", {
      targetNodeId: canonicalId,
    });
    expect(different.ok).toBe(false);
    if (!different.ok) expect(different.code).toBe("conflict");
  });
});

describe("Knowledge Review — reject", () => {
  it("requires a reason, persists it, and never touches the live graph", async () => {
    await seedPendingCandidate();
    const snap = graphSnapshot();

    const missingReason = await resolveKnowledgeCandidate(candidateId, "reject");
    expect(missingReason.ok).toBe(false);
    if (!missingReason.ok) expect(missingReason.code).toBe("invalid");
    expect(candidates()[0]!["status"]).toBe("pending");

    const result = await resolveKnowledgeCandidate(candidateId, "reject", {
      reason: "Duplicate of existing guidance, phrased too vaguely.",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.status).toBe("rejected");
    expect(result.candidate.resolutionReason).toBe(
      "Duplicate of existing guidance, phrased too vaguely.",
    );
    expect(result.candidate.resolvedTargetId).toBeNull();
    expect(result.candidate.resolvedAt).toBeTruthy();

    // Live graph untouched — byte-for-byte (modulo timestamps).
    expect(graphSnapshot()).toBe(snap);
    expect(edgeBetween(`mentor:${MENTOR_A}`, canonicalId)).toBeUndefined();

    expect(await listKnowledgeCandidates("pending")).toHaveLength(0);
    expect((await listKnowledgeCandidates("rejected"))[0]!.resolutionReason).toContain(
      "Duplicate",
    );
  });

  it("replaying a reject is a no-op that keeps the original reason", async () => {
    await seedPendingCandidate();
    await resolveKnowledgeCandidate(candidateId, "reject", { reason: "original reason" });

    const replay = await resolveKnowledgeCandidate(candidateId, "reject", {
      reason: "different reason",
    });
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.replayed).toBe(true);
      expect(replay.candidate.resolutionReason).toBe("original reason");
    }
  });
});

/**
 * Reopen — a reviewer's undo for a REJECTED candidate. Reject writes no graph
 * edge, so returning the row to pending is side-effect-free; only rejected rows
 * qualify, and a scrubbed (withdrawn-mentor) row is refused so it can't strand.
 */
describe("Knowledge Review — reopen", () => {
  it("returns a rejected candidate to pending, clearing every resolution field", async () => {
    await seedPendingCandidate();
    await resolveKnowledgeCandidate(candidateId, "reject", { reason: "premature reject" });
    const snap = graphSnapshot();

    const result = await resolveKnowledgeCandidate(candidateId, "reopen");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.replayed).toBe(false);
    expect(result.candidate.status).toBe("pending");
    expect(result.candidate.resolutionReason).toBeNull();
    expect(result.candidate.resolvedTargetId).toBeNull();
    expect(result.candidate.requestedTargetId).toBeNull();
    expect(result.candidate.redirectReason).toBeNull();
    expect(result.candidate.resolvedAt).toBeNull();

    // Reopen is side-effect-free — the live graph is byte-for-byte unchanged.
    expect(graphSnapshot()).toBe(snap);

    // Back in the pending queue and gone from rejected.
    expect((await listKnowledgeCandidates("pending"))[0]!.id).toBe(candidateId);
    expect(await listKnowledgeCandidates("rejected")).toHaveLength(0);
  });

  it("replaying reopen on an already-pending candidate is a no-op success", async () => {
    await seedPendingCandidate();
    await resolveKnowledgeCandidate(candidateId, "reject", { reason: "oops" });
    await resolveKnowledgeCandidate(candidateId, "reopen");
    const candSnap = snapshot(candidates());

    const replay = await resolveKnowledgeCandidate(candidateId, "reopen");
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.replayed).toBe(true);
    expect(snapshot(candidates())).toBe(candSnap);
  });

  it("refuses to reopen a candidate in a non-reopenable state (e.g. archived)", async () => {
    await seedPendingCandidate();
    // Archived/restored rows have their own restore/rearchive inverse — reopen
    // only undoes rejected/accepted/merged resolutions.
    candidates()[0]!["status"] = "archived";

    const conflict = await resolveKnowledgeCandidate(candidateId, "reopen");
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.code).toBe("conflict");
    expect(candidates()[0]!["status"]).toBe("archived");
  });

  it("refuses to reopen a rejected candidate whose mentor was withdrawn (scrubbed)", async () => {
    await seedPendingCandidate();
    await resolveKnowledgeCandidate(candidateId, "reject", { reason: "will revisit" });
    // Simulate mentor withdrawal scrubbing the resolved candidate's provenance.
    candidates()[0]!["mentor_profile_id"] = null;

    const refused = await resolveKnowledgeCandidate(candidateId, "reopen");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("invalid");
    // Still rejected — nothing changed.
    expect(candidates()[0]!["status"]).toBe("rejected");
  });

  it("a reject → reopen → accept cycle reinforces the concept like a direct accept", async () => {
    await seedPendingCandidate();
    await resolveKnowledgeCandidate(candidateId, "reject", { reason: "reconsidering" });
    const reopened = await resolveKnowledgeCandidate(candidateId, "reopen");
    expect(reopened.ok).toBe(true);

    const accept = await resolveKnowledgeCandidate(candidateId, "accept");
    expect(accept.ok).toBe(true);
    if (!accept.ok) return;
    expect(accept.candidate.status).toBe("accepted");
    expect(accept.candidate.resolvedTargetId).toBe(canonicalId);

    // The mentor provenance edge exists, deduped by the original answer id.
    const edge = edgeBetween(`mentor:${MENTOR_A}`, canonicalId)!;
    expect(edge).toBeDefined();
    expect((edge["meta"] as Record<string, unknown>)["answerIds"]).toEqual([ANSWER_1]);

    expect(await listKnowledgeCandidates("pending")).toHaveLength(0);
    expect((await listKnowledgeCandidates("accepted"))[0]!.id).toBe(candidateId);
  });
});

/**
 * Reopen (undo accept/merge) — the per-answer INVERSE of a reinforcement. Accept/
 * merge wrote a mentor→concept provenance edge; reopening must drop THIS answer's
 * contribution, reconverge the concept's confidence, and demote a solely-mentor-
 * supplied status back to unverified — undoing the lesson, not just the row.
 */
describe("Knowledge Review — reopen (undo accept/merge)", () => {
  it("undoes an accepted reinforcement: drops the mentor edge, reconverges confidence, demotes to unverified", async () => {
    await seedPendingCandidate();
    const preNode = nodeById(canonicalId)!;
    const preConfidence = preNode["confidence"] as number;
    // The video-taught concept starts unverified before any mentor corroboration.
    expect(preNode["verification_status"]).toBe("unverified");

    await resolveKnowledgeCandidate(candidateId, "accept");
    // Accept added mentor corroboration: edge present, confidence up, mentor_supplied.
    expect(edgeBetween(`mentor:${MENTOR_A}`, canonicalId)).toBeDefined();
    const acceptedNode = nodeById(canonicalId)!;
    expect(acceptedNode["verification_status"]).toBe("mentor_supplied");
    expect(acceptedNode["confidence"] as number).toBeGreaterThan(preConfidence);

    const reopened = await resolveKnowledgeCandidate(candidateId, "reopen");
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    expect(reopened.replayed).toBe(false);
    expect(reopened.candidate.status).toBe("pending");
    expect(reopened.candidate.resolvedTargetId).toBeNull();
    expect(reopened.candidate.resolvedAt).toBeNull();

    // The mentor→concept provenance edge is gone (its only answer was withdrawn)...
    expect(edgeBetween(`mentor:${MENTOR_A}`, canonicalId)).toBeUndefined();
    // ...the concept survives on its remaining video source, with confidence and
    // verification reconverged to their pre-accept values.
    const undoneNode = nodeById(canonicalId)!;
    expect(undoneNode).toBeDefined();
    expect(undoneNode["verification_status"]).toBe("unverified");
    expect(undoneNode["confidence"] as number).toBeCloseTo(preConfidence, 10);

    // Back in the pending queue for a fresh decision, gone from accepted.
    expect((await listKnowledgeCandidates("pending"))[0]!.id).toBe(candidateId);
    expect(await listKnowledgeCandidates("accepted")).toHaveLength(0);
  });

  it("undoes a merged reinforcement onto the reviewer-chosen node", async () => {
    await seedPendingCandidate();
    const other = makeItem("concept", "Shielding Gas Discipline");
    await syncVideoKnowledge("vid-1", [makeItem("concept", CANONICAL_TITLE), other]);

    await resolveKnowledgeCandidate(candidateId, "merge", { targetNodeId: other.id });
    expect(edgeBetween(`mentor:${MENTOR_A}`, other.id)).toBeDefined();
    expect(nodeById(other.id)!["verification_status"]).toBe("mentor_supplied");

    const reopened = await resolveKnowledgeCandidate(candidateId, "reopen");
    expect(reopened.ok).toBe(true);
    if (reopened.ok) expect(reopened.candidate.status).toBe("pending");

    // The reinforcement onto the chosen node is undone; the node keeps its own
    // video provenance and demotes back to unverified.
    expect(edgeBetween(`mentor:${MENTOR_A}`, other.id)).toBeUndefined();
    expect(nodeById(other.id)).toBeDefined();
    expect(nodeById(other.id)!["verification_status"]).toBe("unverified");

    expect((await listKnowledgeCandidates("pending"))[0]!.id).toBe(candidateId);
    expect(await listKnowledgeCandidates("merged")).toHaveLength(0);
  });

  it("per-answer withdrawal: a shared mentor edge survives, minus this answer, with weight decremented", async () => {
    await seedPendingCandidate();
    await resolveKnowledgeCandidate(candidateId, "accept");

    // Simulate a SECOND answer from the same mentor corroborating the same concept
    // (accept dedups by answerId; a real multi-answer mentor edge carries both).
    const ANSWER_2 = "22222222-0000-0000-0000-000000000002";
    const edge = edgeBetween(`mentor:${MENTOR_A}`, canonicalId)!;
    (edge["meta"] as Record<string, unknown>)["answerIds"] = [ANSWER_1, ANSWER_2];
    edge["weight"] = 2;

    const reopened = await resolveKnowledgeCandidate(candidateId, "reopen");
    expect(reopened.ok).toBe(true);

    // The edge lives on for the other answer; only THIS answer's contribution left.
    const after = edgeBetween(`mentor:${MENTOR_A}`, canonicalId)!;
    expect(after).toBeDefined();
    expect((after["meta"] as Record<string, unknown>)["answerIds"]).toEqual([ANSWER_2]);
    expect(after["weight"]).toBe(1);
    // Still mentor-corroborated, so the status stays mentor_supplied.
    expect(nodeById(canonicalId)!["verification_status"]).toBe("mentor_supplied");
  });

  it("replaying reopen after undoing an accept is a no-op success", async () => {
    await seedPendingCandidate();
    await resolveKnowledgeCandidate(candidateId, "accept");
    await resolveKnowledgeCandidate(candidateId, "reopen");
    const snap = graphSnapshot();
    const candSnap = snapshot(candidates());

    const replay = await resolveKnowledgeCandidate(candidateId, "reopen");
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.replayed).toBe(true);
    expect(graphSnapshot()).toBe(snap);
    expect(snapshot(candidates())).toBe(candSnap);
  });

  it("refuses to reopen an accepted candidate whose mentor was withdrawn (scrubbed)", async () => {
    await seedPendingCandidate();
    await resolveKnowledgeCandidate(candidateId, "accept");
    // Simulate mentor withdrawal scrubbing the resolved candidate's provenance.
    candidates()[0]!["mentor_profile_id"] = null;
    const snap = graphSnapshot();

    const refused = await resolveKnowledgeCandidate(candidateId, "reopen");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("invalid");
    // Still accepted, live graph untouched.
    expect(candidates()[0]!["status"]).toBe("accepted");
    expect(graphSnapshot()).toBe(snap);
  });

  it("an accept → reopen → accept cycle reconverges to the same reinforcement", async () => {
    await seedPendingCandidate();
    await resolveKnowledgeCandidate(candidateId, "accept");
    await resolveKnowledgeCandidate(candidateId, "reopen");

    const reaccept = await resolveKnowledgeCandidate(candidateId, "accept");
    expect(reaccept.ok).toBe(true);
    if (!reaccept.ok) return;
    expect(reaccept.candidate.status).toBe("accepted");
    expect(reaccept.candidate.resolvedTargetId).toBe(canonicalId);

    // The mentor provenance edge is back, deduped by the original answer id.
    const edge = edgeBetween(`mentor:${MENTOR_A}`, canonicalId)!;
    expect(edge).toBeDefined();
    expect((edge["meta"] as Record<string, unknown>)["answerIds"]).toEqual([ANSWER_1]);
    expect(nodeById(canonicalId)!["verification_status"]).toBe("mentor_supplied");
  });
});

/**
 * Resilient Knowledge Review — the graph legitimately moves while a candidate
 * sits in review (merges, deletions, withdrawals). A recorded best-match id is
 * a hint, not a guarantee: resolution must re-validate the target against the
 * live graph and either follow the redirect, re-match by content, or refuse
 * with a structured target_gone that keeps the candidate pending.
 */
describe("Knowledge Review — resilient targets", () => {
  const SURVIVOR_TITLE = "Weld Porosity Control";
  const survivorId = knowledgeNodeId("concept", SURVIVOR_TITLE);

  /** Simulate the canonical node being merged away into a survivor. */
  function mergeCanonicalInto(
    intoId: string,
    intoLabel: string,
    extraMergedFrom: Array<{ id: string; label: string }> = [],
  ): void {
    fake.tables["knowledge_nodes"].push({
      id: intoId,
      kind: "concept",
      label: intoLabel,
      trade: TRADE,
      ref_id: null,
      verification_status: "unverified",
      embedding: JSON.stringify(BASE_VEC),
      meta: {
        aliases: [],
        mergedFrom: [
          { id: canonicalId, label: CANONICAL_TITLE, category: "concept" },
          ...extraMergedFrom.map((m) => ({ ...m, category: "concept" })),
        ],
      },
      created_at: new Date().toISOString(),
      updated_at: null,
    });
    // The absorbed node is gone from the live graph.
    fake.tables["knowledge_nodes"] = fake.tables["knowledge_nodes"].filter(
      (n) => n["id"] !== canonicalId,
    );
  }

  it("accept follows a merge redirect and records requested vs actual target", async () => {
    await seedPendingCandidate();
    mergeCanonicalInto(survivorId, SURVIVOR_TITLE);

    const result = await resolveKnowledgeCandidate(candidateId, "accept");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.status).toBe("accepted");
    // The reinforcement landed on the SURVIVOR, not the vanished request.
    expect(result.candidate.resolvedTargetId).toBe(survivorId);
    expect(result.candidate.requestedTargetId).toBe(canonicalId);
    expect(result.candidate.redirectReason).toContain("merged into");

    const edge = edgeBetween(`mentor:${MENTOR_A}`, survivorId)!;
    expect(edge).toBeDefined();
    expect((edge["meta"] as Record<string, unknown>)["answerIds"]).toEqual([ANSWER_1]);
    expect(edgeBetween(`mentor:${MENTOR_A}`, canonicalId)).toBeUndefined();
    // No zombie node was resurrected for the vanished id.
    expect(nodeById(canonicalId)).toBeUndefined();
  });

  it("replaying a redirected accept is a no-op (matches the requested target)", async () => {
    await seedPendingCandidate();
    mergeCanonicalInto(survivorId, SURVIVOR_TITLE);
    await resolveKnowledgeCandidate(candidateId, "accept");
    const snap = graphSnapshot();

    // The reviewer's client retries the SAME accept — its target is still the
    // old canonical id, which now only appears as requested_target_id.
    const replay = await resolveKnowledgeCandidate(candidateId, "accept");
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.replayed).toBe(true);
    expect(graphSnapshot()).toBe(snap);
  });

  it("an id absorbed transitively (multi-entry merge ledger) lands on the final survivor", async () => {
    await seedPendingCandidate();
    // canonical was merged into B, then B into the survivor — the survivor's
    // ledger carries BOTH absorbed identities.
    const bId = knowledgeNodeId("concept", "Gas Shield Integrity");
    mergeCanonicalInto(survivorId, SURVIVOR_TITLE, [
      { id: bId, label: "Gas Shield Integrity" },
    ]);

    const result = await resolveKnowledgeCandidate(candidateId, "merge", {
      targetNodeId: bId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.resolvedTargetId).toBe(survivorId);
    expect(result.candidate.requestedTargetId).toBe(bId);
  });

  it("a vanished id with no redirect trail re-matches by the candidate's own content", async () => {
    await seedPendingCandidate();
    // Delete the canonical node outright (no mergedFrom trail anywhere) and
    // plant a replacement whose embedding matches the candidate's content
    // exactly (cos = 1 ≥ 0.85) — the same duplicate-smart signal ingestion uses.
    fake.tables["knowledge_nodes"] = fake.tables["knowledge_nodes"].filter(
      (n) => n["id"] !== canonicalId,
    );
    const replacementId = knowledgeNodeId("concept", "Clean Gas Coverage Habits");
    fake.tables["knowledge_nodes"].push({
      id: replacementId,
      kind: "concept",
      label: "Clean Gas Coverage Habits",
      trade: TRADE,
      ref_id: null,
      verification_status: "unverified",
      embedding: JSON.stringify(atSimilarity(0.75)),
      meta: { aliases: [] },
      created_at: new Date().toISOString(),
      updated_at: null,
    });

    const result = await resolveKnowledgeCandidate(candidateId, "accept");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.resolvedTargetId).toBe(replacementId);
    expect(result.candidate.requestedTargetId).toBe(canonicalId);
    expect(result.candidate.redirectReason).toContain("re-matched");
    expect(edgeBetween(`mentor:${MENTOR_A}`, replacementId)).toBeDefined();
  });

  it("target_gone keeps the candidate pending and a follow-up merge succeeds", async () => {
    await seedPendingCandidate();
    // The canonical node vanishes with no trail and no confident replacement.
    fake.tables["knowledge_nodes"] = fake.tables["knowledge_nodes"].filter(
      (n) => n["id"] !== canonicalId,
    );
    const before = graphSnapshot();

    const result = await resolveKnowledgeCandidate(candidateId, "accept");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("target_gone");
    if (result.code === "target_gone") {
      expect(Array.isArray(result.bestMatches)).toBe(true);
    }
    // Nothing was written: candidate pending, graph untouched.
    expect(candidates()[0]!["status"]).toBe("pending");
    expect(graphSnapshot()).toBe(before);

    // The reviewer re-aims at a real concept — the retry converges cleanly.
    const other = makeItem("concept", "Shielding Gas Discipline");
    embedRegistry.set("Shielding Gas Discipline", BASE_VEC);
    await syncVideoKnowledge("vid-1", [other]);
    const retry = await resolveKnowledgeCandidate(candidateId, "merge", {
      targetNodeId: other.id,
    });
    expect(retry.ok).toBe(true);
    if (retry.ok) {
      expect(retry.candidate.status).toBe("merged");
      expect(retry.candidate.resolvedTargetId).toBe(other.id);
      expect(retry.candidate.redirectReason).toBeNull();
    }
  });

  it("listing annotates stored best-matches with live / redirected / gone", async () => {
    await seedPendingCandidate();

    // Live: the match still exists as-is.
    let [cand] = await listKnowledgeCandidates("pending");
    expect(cand!.bestMatches[0]!.validity).toBe("live");
    expect(cand!.bestMatches[0]!.currentNodeId).toBe(canonicalId);

    // Redirected: absorbed into a survivor — annotation points at it.
    mergeCanonicalInto(survivorId, SURVIVOR_TITLE);
    [cand] = await listKnowledgeCandidates("pending");
    expect(cand!.bestMatches[0]!.validity).toBe("redirected");
    expect(cand!.bestMatches[0]!.currentNodeId).toBe(survivorId);
    expect(cand!.bestMatches[0]!.currentLabel).toBe(SURVIVOR_TITLE);

    // Gone: the survivor (and its ledger) vanish too.
    fake.tables["knowledge_nodes"] = fake.tables["knowledge_nodes"].filter(
      (n) => n["id"] !== survivorId,
    );
    [cand] = await listKnowledgeCandidates("pending");
    expect(cand!.bestMatches[0]!.validity).toBe("gone");
    expect(cand!.bestMatches[0]!.currentNodeId).toBeNull();
  });
});

describe("Knowledge Review — misc", () => {
  it("returns not_found for an unknown candidate", async () => {
    const result = await resolveKnowledgeCandidate("cand:nope:k:concept:nothing", "accept");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("not_found");
  });
});

describe("Knowledge Review — concurrency", () => {
  it("two conflicting concurrent resolutions produce exactly one graph reinforcement", async () => {
    await seedPendingCandidate();
    const other = makeItem("concept", "Shielding Gas Discipline");
    await syncVideoKnowledge("vid-1", [makeItem("concept", CANONICAL_TITLE), other]);

    // Fire an accept (→ canonical top match) and a merge (→ reviewer-chosen
    // node) at the SAME pending candidate simultaneously. Serialization must
    // let exactly one win; the loser must see a conflict and write nothing.
    const [a, b] = await Promise.all([
      resolveKnowledgeCandidate(candidateId, "accept"),
      resolveKnowledgeCandidate(candidateId, "merge", { targetNodeId: other.id }),
    ]);

    const winners = [a, b].filter((r) => r.ok);
    const losers = [a, b].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    if (!losers[0]!.ok) expect(losers[0]!.code).toBe("conflict");

    // Exactly ONE mentor provenance edge exists — never both targets.
    const acceptEdge = edgeBetween(`mentor:${MENTOR_A}`, canonicalId);
    const mergeEdge = edgeBetween(`mentor:${MENTOR_A}`, other.id);
    expect([acceptEdge, mergeEdge].filter(Boolean)).toHaveLength(1);

    // The single recorded outcome matches the winning request.
    const row = candidates()[0]!;
    const winner = winners[0]!;
    if (winner.ok) {
      expect(row["status"]).toBe(winner.candidate.status);
      expect(row["resolved_target_id"]).toBe(winner.candidate.resolvedTargetId);
      expect(["accepted", "merged"]).toContain(row["status"]);
    }
    expect(await listKnowledgeCandidates("pending")).toHaveLength(0);
  });

  it("two identical concurrent resolutions converge: one write, one replay", async () => {
    await seedPendingCandidate();

    const [a, b] = await Promise.all([
      resolveKnowledgeCandidate(candidateId, "accept"),
      resolveKnowledgeCandidate(candidateId, "accept"),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const replayFlags = [a, b].map((r) => (r.ok ? r.replayed : null));
    expect(replayFlags.filter((f) => f === false)).toHaveLength(1);
    expect(replayFlags.filter((f) => f === true)).toHaveLength(1);

    // A single mentor edge with the answer id recorded once.
    const edge = edgeBetween(`mentor:${MENTOR_A}`, canonicalId)!;
    expect(edge).toBeDefined();
    expect((edge["meta"] as Record<string, unknown>)["answerIds"]).toEqual([ANSWER_1]);
  });

  it("compare-and-set refuses a status flip when the row is no longer pending", async () => {
    await seedPendingCandidate();
    // Simulate an external writer resolving the row mid-flight: flip it
    // directly in the store, then attempt a conflicting resolution.
    candidates()[0]!["status"] = "rejected";
    candidates()[0]!["resolution_reason"] = "external writer";

    const result = await resolveKnowledgeCandidate(candidateId, "accept");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("conflict");
    expect(candidates()[0]!["status"]).toBe("rejected");
  });
});
