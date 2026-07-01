/**
 * Guard tests for the reinforcement-first mentor ingestion policy: mentor
 * answers must reinforce the shared knowledge graph (video↔mentor and
 * mentor↔mentor collapse onto the SAME canonical node), uncertain matches are
 * queued OUTSIDE the live graph as pending candidates, confidently novel
 * concepts create new nodes, and slang/alias wordings resolve to the canonical
 * concept. Replaying the same answerId must be a strict no-op everywhere
 * (nodes, edges, candidates).
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
} from "../memory-graph.js";

const TRADE = "Welder";
const MENTOR_A = "aaaaaaaa-0000-0000-0000-000000000001";
const MENTOR_B = "bbbbbbbb-0000-0000-0000-000000000002";
const ANSWER_1 = "11111111-0000-0000-0000-000000000001";
const ANSWER_2 = "22222222-0000-0000-0000-000000000002";
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
const knowledgeNodes = () =>
  nodes().filter((n) => (n["id"] as string).startsWith("k:"));
const provTo = (conceptId: string) =>
  edges().filter((e) => e["target_id"] === conceptId && e["kind"] === "knowledge");
const edgeBetween = (source: string, target: string) =>
  edges().find((e) => e["source_id"] === source && e["target_id"] === target);

/**
 * 16-dim unit vectors with a controlled cosine similarity to the base vector:
 * cos(base, atSimilarity(s)) === s exactly.
 */
const BASE_VEC = [1, ...Array(15).fill(0)] as number[];

/**
 * Stable snapshot of rows for idempotency comparisons: recursively strips
 * write-time bookkeeping fields (`updated_at`, `extractedAt`, `at`, ...) that
 * legitimately move on every upsert, so only semantic drift fails the test.
 */
const TIME_KEYS = new Set(["created_at", "updated_at", "extractedAt", "firstExtractedAt", "lastExtractedAt", "at"]);
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
const atSimilarity = (s: number): number[] => [
  s,
  Math.sqrt(1 - s * s),
  ...Array(14).fill(0),
];

beforeEach(async () => {
  resetMocks();
  seedBaseTables();
  await ensureBaseGraph();
});

describe("mentor ingestion — reinforcement across sources", () => {
  it("a mentor answer reinforces the SAME node a video created (no fragmentation)", async () => {
    const v = "vid-1";
    await seedVideo(v);
    const item = makeItem("concept", "Travel Speed", { timestamps: [10], confidence: 0.7 });
    await syncVideoKnowledge(v, [item]);

    const before = knowledgeNodes().length;
    const outcomes = await syncMentorAnswerKnowledge(
      MENTOR_A,
      "Alice",
      [makeItem("concept", "Travel Speed", { confidence: 0.9 })],
      { answerId: ANSWER_1, trade: TRADE, sessionId: SESSION },
    );

    // Exact-id signal: same deterministic node, zero new knowledge nodes.
    expect(knowledgeNodes().length).toBe(before);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.outcome).toBe("reinforced");
    expect(outcomes[0]!.canonicalId).toBe(item.id);

    // Provenance is edge-owned: one edge from the video AND one from the mentor.
    const prov = provTo(item.id);
    expect(prov.map((e) => e["source_id"]).sort()).toEqual(
      [`mentor:${MENTOR_A}`, `video:${v}`].sort(),
    );
    expect(nodeById(item.id)?.["verification_status"]).toBe("mentor_supplied");
  });

  it("two mentors giving the same concept share one node with two provenance edges", async () => {
    const item = makeItem("concept", "Arc Length Control");
    const first = await syncMentorAnswerKnowledge(MENTOR_A, "Alice", [item], {
      answerId: ANSWER_1,
      trade: TRADE,
    });
    expect(first[0]!.outcome).toBe("created");

    const second = await syncMentorAnswerKnowledge(MENTOR_B, "Bob", [makeItem("concept", "Arc Length Control")], {
      answerId: ANSWER_2,
      trade: TRADE,
    });
    expect(second[0]!.outcome).toBe("reinforced");

    expect(knowledgeNodes().filter((n) => n["id"] === item.id)).toHaveLength(1);
    const prov = provTo(item.id);
    expect(prov.map((e) => e["source_id"]).sort()).toEqual(
      [`mentor:${MENTOR_A}`, `mentor:${MENTOR_B}`].sort(),
    );
  });

  it("replaying the same answerId is a no-op for nodes, edge weights, and candidates", async () => {
    const items = [
      makeItem("concept", "Puddle Control"),
      makeItem("procedure", "Whip and Pause"),
    ];
    await syncMentorAnswerKnowledge(MENTOR_A, "Alice", items, {
      answerId: ANSWER_1,
      trade: TRADE,
      sessionId: SESSION,
    });

    const snapNodes = snapshot(nodes());
    const snapEdges = snapshot(edges());
    const snapCands = snapshot(candidates());
    const edgeId = `e:mentor:${MENTOR_A}->${items[0]!.id}`;
    const weightBefore = edges().find((e) => e["id"] === edgeId)?.["weight"];

    await syncMentorAnswerKnowledge(MENTOR_A, "Alice", items, {
      answerId: ANSWER_1,
      trade: TRADE,
      sessionId: SESSION,
    });

    expect(snapshot(nodes())).toBe(snapNodes);
    expect(snapshot(edges())).toBe(snapEdges);
    expect(snapshot(candidates())).toBe(snapCands);
    const edge = edges().find((e) => e["id"] === edgeId)!;
    expect(edge["weight"]).toBe(weightBefore);
    const meta = edge["meta"] as Record<string, unknown>;
    expect(meta["answerIds"]).toEqual([ANSWER_1]);
  });

  it("a distinct answer from the same mentor strengthens the edge (weight = corroborating answers)", async () => {
    const item = makeItem("concept", "Heat Input");
    await syncMentorAnswerKnowledge(MENTOR_A, "Alice", [item], { answerId: ANSWER_1, trade: TRADE });
    await syncMentorAnswerKnowledge(MENTOR_A, "Alice", [makeItem("concept", "Heat Input")], {
      answerId: ANSWER_2,
      trade: TRADE,
    });

    const edge = edgeBetween(`mentor:${MENTOR_A}`, item.id)!;
    expect(edge["weight"]).toBe(2);
    expect((edge["meta"] as Record<string, unknown>)["answerIds"]).toEqual([ANSWER_1, ANSWER_2]);
  });
});

describe("mentor ingestion — three-band decision", () => {
  it("a high-similarity differently-worded concept reinforces the canonical node and records an alias", async () => {
    const v = "vid-1";
    await seedVideo(v);
    const canonical = makeItem("concept", "Shielded Metal Arc Welding");
    embedRegistry.set("Shielded Metal Arc Welding", BASE_VEC);
    await syncVideoKnowledge(v, [canonical]);

    // cos = 0.9 ≥ 0.85 → confident reinforce, different wording.
    embedRegistry.set("Stick Welding", atSimilarity(0.9));
    const outcomes = await syncMentorAnswerKnowledge(
      MENTOR_A,
      "Alice",
      [makeItem("concept", "Stick Welding")],
      { answerId: ANSWER_1, trade: TRADE },
    );

    expect(outcomes[0]!.outcome).toBe("reinforced");
    expect(outcomes[0]!.canonicalId).toBe(canonical.id);
    expect(outcomes[0]!.matchedLabel).toBe("Shielded Metal Arc Welding");
    // No new node was minted for the mentor's wording.
    expect(nodeById(knowledgeNodeId("concept", "Stick Welding"))).toBeUndefined();
    // The wording is recorded as an alias on the canonical node.
    const meta = nodeById(canonical.id)?.["meta"] as Record<string, unknown>;
    expect(meta["aliases"]).toContain("Stick Welding");
  });

  it("a recorded alias makes future mentors match directly, even from the slang category", async () => {
    const v = "vid-1";
    await seedVideo(v);
    const canonical = makeItem("concept", "Shielded Metal Arc Welding");
    embedRegistry.set("Shielded Metal Arc Welding", BASE_VEC);
    await syncVideoKnowledge(v, [canonical]);
    embedRegistry.set("Stick Welding", atSimilarity(0.9));
    await syncMentorAnswerKnowledge(MENTOR_A, "Alice", [makeItem("concept", "Stick Welding")], {
      answerId: ANSWER_1,
      trade: TRADE,
    });

    // Mentor B uses the slang wording — hits the alias index across categories.
    const outcomes = await syncMentorAnswerKnowledge(
      MENTOR_B,
      "Bob",
      [makeItem("slang", "Stick Welding")],
      { answerId: ANSWER_2, trade: TRADE },
    );
    expect(outcomes[0]!.outcome).toBe("reinforced");
    expect(outcomes[0]!.canonicalId).toBe(canonical.id);
    expect(nodeById(knowledgeNodeId("slang", "Stick Welding"))).toBeUndefined();
    // Both mentors corroborate the SAME canonical concept.
    expect(provTo(canonical.id).map((e) => e["source_id"]).sort()).toEqual(
      [`mentor:${MENTOR_A}`, `mentor:${MENTOR_B}`, "vid-1"].map((s) =>
        s === "vid-1" ? "video:vid-1" : s,
      ).sort(),
    );
  });

  it("slang naming an existing concept label reinforces it instead of minting a slang node", async () => {
    const v = "vid-1";
    await seedVideo(v);
    const canonical = makeItem("concept", "Undercut");
    await syncVideoKnowledge(v, [canonical]);

    const outcomes = await syncMentorAnswerKnowledge(
      MENTOR_A,
      "Alice",
      [makeItem("slang", "Undercut")],
      { answerId: ANSWER_1, trade: TRADE },
    );
    expect(outcomes[0]!.outcome).toBe("reinforced");
    expect(outcomes[0]!.canonicalId).toBe(canonical.id);
    expect(nodeById(knowledgeNodeId("slang", "Undercut"))).toBeUndefined();
  });

  it("a plausible-but-uncertain concept is queued as a candidate, NOT added to the live graph", async () => {
    const v = "vid-1";
    await seedVideo(v);
    const canonical = makeItem("concept", "Porosity Prevention");
    embedRegistry.set("Porosity Prevention", BASE_VEC);
    await syncVideoKnowledge(v, [canonical]);

    // cos = 0.75 → middle band (0.70–0.85): queue for review.
    const uncertain = makeItem("concept", "Keeping Gas Coverage Clean", { confidence: 0.8 });
    embedRegistry.set("Keeping Gas Coverage Clean", atSimilarity(0.75));
    const before = knowledgeNodes().length;
    const outcomes = await syncMentorAnswerKnowledge(MENTOR_A, "Alice", [uncertain], {
      answerId: ANSWER_1,
      trade: TRADE,
      sessionId: SESSION,
    });

    expect(outcomes[0]!.outcome).toBe("queued");
    expect(outcomes[0]!.canonicalId).toBeNull();
    // The live graph is untouched: no new node, no mentor edge.
    expect(knowledgeNodes().length).toBe(before);
    expect(nodeById(uncertain.id)).toBeUndefined();
    expect(edgeBetween(`mentor:${MENTOR_A}`, canonical.id)).toBeUndefined();

    // The candidate row preserves the concept and its best-match context.
    const cands = await listKnowledgeCandidates("pending");
    expect(cands).toHaveLength(1);
    expect(cands[0]!.id).toBe(`cand:${ANSWER_1}:${uncertain.id}`);
    expect(cands[0]!.title).toBe("Keeping Gas Coverage Clean");
    expect(cands[0]!.mentorProfileId).toBe(MENTOR_A);
    expect(cands[0]!.answerId).toBe(ANSWER_1);
    expect(cands[0]!.sessionId).toBe(SESSION);
    expect(cands[0]!.bestMatches[0]!.nodeId).toBe(canonical.id);
    expect(cands[0]!.bestMatches[0]!.similarity).toBeCloseTo(0.75, 5);
  });

  it("replaying an answer never duplicates a candidate or resets a reviewed status", async () => {
    const v = "vid-1";
    await seedVideo(v);
    embedRegistry.set("Porosity Prevention", BASE_VEC);
    await syncVideoKnowledge(v, [makeItem("concept", "Porosity Prevention")]);

    const uncertain = makeItem("concept", "Keeping Gas Coverage Clean");
    embedRegistry.set("Keeping Gas Coverage Clean", atSimilarity(0.75));
    const run = () =>
      syncMentorAnswerKnowledge(MENTOR_A, "Alice", [uncertain], {
        answerId: ANSWER_1,
        trade: TRADE,
        sessionId: SESSION,
      });

    await run();
    expect(candidates()).toHaveLength(1);

    // A reviewer resolves the candidate; replaying the answer must not undo it.
    candidates()[0]!["status"] = "accepted";
    await run();
    expect(candidates()).toHaveLength(1);
    expect(candidates()[0]!["status"]).toBe("accepted");
  });

  it("a confidently novel concept creates a new node with mentor provenance", async () => {
    const v = "vid-1";
    await seedVideo(v);
    await syncVideoKnowledge(v, [makeItem("concept", "Travel Speed")]);

    // Default hash embeddings are near-orthogonal → below the novelty band.
    const novel = makeItem("concept", "Duty Cycle Management", { confidence: 0.7 });
    const outcomes = await syncMentorAnswerKnowledge(MENTOR_A, "Alice", [novel], {
      answerId: ANSWER_1,
      trade: TRADE,
    });

    expect(outcomes[0]!.outcome).toBe("created");
    expect(outcomes[0]!.canonicalId).toBe(novel.id);
    const node = nodeById(novel.id)!;
    expect(node["verification_status"]).toBe("mentor_supplied");
    expect(provTo(novel.id).map((e) => e["source_id"])).toEqual([`mentor:${MENTOR_A}`]);
    expect(candidates()).toHaveLength(0);
  });
});
