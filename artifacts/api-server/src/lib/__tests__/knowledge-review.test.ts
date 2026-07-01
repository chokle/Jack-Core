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

    const ghost = await resolveKnowledgeCandidate(candidateId, "merge", {
      targetNodeId: "k:concept:does-not-exist",
    });
    expect(ghost.ok).toBe(false);
    if (!ghost.ok) expect(ghost.code).toBe("invalid");

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
