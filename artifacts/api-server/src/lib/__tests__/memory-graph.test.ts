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

import { fake, embedRegistry, defaultEmbed, resetMocks, MODELS } from "./mocks.js";
import {
  ensureBaseGraph,
  syncVideoGraph,
  syncVideoKnowledge,
  syncMentorAnswerKnowledge,
  removeVideoGraph,
  removeMentorGraph,
  withdrawMentor,
  previewMentorWithdrawal,
  rebuildGraph,
  knowledgeNodeId,
  setNodeVerification,
  GRAPH_CORE_ID,
} from "../memory-graph.js";

const TRADE = "Welder";

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
    timestamps: extra.timestamps ?? [1],
    confidence: extra.confidence ?? 0.6,
    competencyCode: extra.competencyCode ?? null,
  };
}

/** Seed competencies + base scaffold, then register one video row and its node. */
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

/** Convenience readers over the in-memory tables. */
const nodes = () => fake.tables["knowledge_nodes"];
const edges = () => fake.tables["knowledge_edges"];
const nodeById = (id: string) => nodes().find((n) => n["id"] === id);
const provFrom = (videoId: string) =>
  edges().filter((e) => e["source_id"] === `video:${videoId}` && e["kind"] === "knowledge");
const provTo = (conceptId: string) =>
  edges().filter((e) => e["target_id"] === conceptId && e["kind"] === "knowledge");
const hubEdge = (source: string, target: string) =>
  edges().find((e) => e["source_id"] === source && e["target_id"] === target);
const topicId = (trade: string) => `topic:${trade}`;
const compId = (code: string) => `comp:${code}`;

beforeEach(async () => {
  resetMocks();
  seedBaseTables();
  await ensureBaseGraph();
});

describe("syncVideoKnowledge — idempotent, collapsing distillation", () => {
  it("re-processing the same video collapses onto the same nodes (no duplicates)", async () => {
    const v = "vid-1";
    await seedVideo(v);
    const items = [
      makeItem("concept", "Travel Speed", { timestamps: [10] }),
      makeItem("hazard", "Arc Blow", { timestamps: [20] }),
    ];

    await syncVideoKnowledge(v, items);

    const speedId = knowledgeNodeId("concept", "Travel Speed");
    const blowId = knowledgeNodeId("hazard", "Arc Blow");
    expect(nodeById(speedId)).toBeDefined();
    expect(nodeById(blowId)).toBeDefined();
    expect(provFrom(v)).toHaveLength(2);

    // Re-run the exact same distillation output.
    await syncVideoKnowledge(v, items);

    const knowledgeNodes = nodes().filter((n) => n["id"]!.toString().startsWith("k:"));
    expect(knowledgeNodes).toHaveLength(2);
    expect(provFrom(v)).toHaveLength(2);
    // Each concept is corroborated by exactly one source video after the replay.
    expect((nodeById(speedId)!["meta"] as Record<string, unknown>)["sourceCount"]).toBe(1);
    expect((nodeById(blowId)!["meta"] as Record<string, unknown>)["sourceCount"]).toBe(1);
  });

  it("two videos teaching the same concept share one node with both provenance edges", async () => {
    const v1 = "vid-a";
    const v2 = "vid-b";
    await seedVideo(v1);
    await seedVideo(v2);

    const conceptId = knowledgeNodeId("concept", "Root Opening");
    await syncVideoKnowledge(v1, [makeItem("concept", "Root Opening", { confidence: 0.6, timestamps: [5] })]);
    await syncVideoKnowledge(v2, [makeItem("concept", "Root Opening", { confidence: 0.6, timestamps: [9] })]);

    const shared = nodes().filter((n) => n["id"] === conceptId);
    expect(shared).toHaveLength(1);

    expect(provTo(conceptId)).toHaveLength(2);
    const meta = nodeById(conceptId)!["meta"] as Record<string, unknown>;
    expect(meta["sourceCount"]).toBe(2);
    expect((meta["sourceVideoIds"] as string[]).sort()).toEqual([v1, v2].sort());
    // Corroboration (noisy-OR) makes a twice-taught concept more confident than once.
    expect(nodeById(conceptId)!["confidence"] as number).toBeGreaterThan(0.6);
  });

  it("merges a differently-worded duplicate of the same category onto one node", async () => {
    const v1 = "vid-c";
    const v2 = "vid-d";
    await seedVideo(v1);
    await seedVideo(v2);

    // Force the two titles to embed identically so cosine similarity > threshold.
    const shared = defaultEmbed("__arc_blow_cluster__");
    embedRegistry.set("Arc Blow", shared);
    embedRegistry.set("Arc Blowing", shared);

    const canonicalId = knowledgeNodeId("hazard", "Arc Blow");
    const wordedId = knowledgeNodeId("hazard", "Arc Blowing");

    await syncVideoKnowledge(v1, [makeItem("hazard", "Arc Blow")]);
    await syncVideoKnowledge(v2, [makeItem("hazard", "Arc Blowing")]);

    expect(nodeById(canonicalId)).toBeDefined();
    expect(nodeById(wordedId)).toBeUndefined();
    const hazardNodes = nodes().filter((n) => n["kind"] === "hazard");
    expect(hazardNodes).toHaveLength(1);
    expect(provTo(canonicalId)).toHaveLength(2);
    expect((nodeById(canonicalId)!["meta"] as Record<string, unknown>)["sourceCount"]).toBe(2);
  });

  it("preserves a human 'verified'/'rejected' status across re-processing", async () => {
    const v = "vid-e";
    await seedVideo(v);
    const verifiedId = knowledgeNodeId("concept", "Preheat");
    const rejectedId = knowledgeNodeId("concept", "Porosity");
    const items = [makeItem("concept", "Preheat"), makeItem("concept", "Porosity")];

    await syncVideoKnowledge(v, items);

    // A reviewer verifies one concept and rejects another.
    nodeById(verifiedId)!["verification_status"] = "verified";
    nodeById(rejectedId)!["verification_status"] = "rejected";

    // The video is re-processed (e.g. re-transcribed and re-distilled).
    await syncVideoKnowledge(v, items);

    expect(nodeById(verifiedId)!["verification_status"]).toBe("verified");
    expect(nodeById(rejectedId)!["verification_status"]).toBe("rejected");
  });
});

describe("syncVideoKnowledge — alias-index matching (re-uploads can't split concepts)", () => {
  it("a video wording matching a recorded alias collapses onto the existing node", async () => {
    const v1 = "vid-al1";
    const v2 = "vid-al2";
    await seedVideo(v1);
    await seedVideo(v2);

    const canonicalId = knowledgeNodeId("concept", "Root Pass");
    await syncVideoKnowledge(v1, [makeItem("concept", "Root Pass")]);

    // A mentor (or reviewer) already recorded an alternate wording as an alias.
    const node = nodeById(canonicalId)!;
    node["meta"] = { ...(node["meta"] as Record<string, unknown>), aliases: ["First Pass Bead"] };

    // A second video teaches the same concept using the alias wording. Default
    // hash embeddings are dissimilar, so only the alias index can match this.
    await syncVideoKnowledge(v2, [makeItem("concept", "First Pass Bead")]);

    expect(nodeById(knowledgeNodeId("concept", "First Pass Bead"))).toBeUndefined();
    expect(provTo(canonicalId)).toHaveLength(2);
    const meta = nodeById(canonicalId)!["meta"] as Record<string, unknown>;
    expect(meta["sourceCount"]).toBe(2);
  });

  it("a video wording matching another node's LABEL (cross-category) collapses without flipping kind", async () => {
    const v1 = "vid-al3";
    const v2 = "vid-al4";
    await seedVideo(v1);
    await seedVideo(v2);

    // "Stick Welding" exists as a procedure node...
    const canonicalId = knowledgeNodeId("procedure", "Stick Welding");
    await syncVideoKnowledge(v1, [makeItem("procedure", "Stick Welding")]);

    // ...and another video's distillation categorizes the same wording as a concept.
    await syncVideoKnowledge(v2, [makeItem("concept", "Stick Welding")]);

    expect(nodeById(knowledgeNodeId("concept", "Stick Welding"))).toBeUndefined();
    expect(nodeById(canonicalId)!["kind"]).toBe("procedure");
    expect(provTo(canonicalId)).toHaveLength(2);
  });

  it("a semantic merge records the video's wording as an alias, so later uploads match without embeddings", async () => {
    const [v1, v2, v3] = ["vid-al5", "vid-al6", "vid-al7"];
    await seedVideo(v1);
    await seedVideo(v2);
    await seedVideo(v3);

    // First merge happens semantically: identical embeddings above threshold.
    const shared = defaultEmbed("__undercut_cluster__");
    embedRegistry.set("Undercut", shared);
    embedRegistry.set("Undercutting", shared);

    const canonicalId = knowledgeNodeId("hazard", "Undercut");
    await syncVideoKnowledge(v1, [makeItem("hazard", "Undercut")]);
    await syncVideoKnowledge(v2, [makeItem("hazard", "Undercutting")]);

    // The merged-in wording is now a recorded alias on the canonical node.
    const meta = nodeById(canonicalId)!["meta"] as Record<string, unknown>;
    expect(meta["aliases"]).toEqual(["Undercutting"]);

    // A third upload uses the same wording but embeds differently (e.g. a new
    // embedding model) — the alias index still collapses it onto the same node.
    embedRegistry.set("Undercutting", defaultEmbed("__totally_different__"));
    await syncVideoKnowledge(v3, [makeItem("hazard", "Undercutting")]);

    expect(nodeById(knowledgeNodeId("hazard", "Undercutting"))).toBeUndefined();
    expect(provTo(canonicalId)).toHaveLength(3);
    expect(nodes().filter((n) => n["kind"] === "hazard")).toHaveLength(1);
  });

  it("replaying an alias-merged video never duplicates aliases or provenance", async () => {
    const v1 = "vid-al8";
    const v2 = "vid-al9";
    await seedVideo(v1);
    await seedVideo(v2);

    const shared = defaultEmbed("__spatter_cluster__");
    embedRegistry.set("Spatter", shared);
    embedRegistry.set("Weld Spatter", shared);

    const canonicalId = knowledgeNodeId("hazard", "Spatter");
    await syncVideoKnowledge(v1, [makeItem("hazard", "Spatter")]);
    await syncVideoKnowledge(v2, [makeItem("hazard", "Weld Spatter")]);
    await syncVideoKnowledge(v2, [makeItem("hazard", "Weld Spatter")]);

    const meta = nodeById(canonicalId)!["meta"] as Record<string, unknown>;
    expect(meta["aliases"]).toEqual(["Weld Spatter"]);
    expect(provTo(canonicalId)).toHaveLength(2);
    expect(meta["sourceCount"]).toBe(2);
  });

  it("a middle-band video concept still CREATES a new node (no queue for videos)", async () => {
    const v1 = "vid-al10";
    const v2 = "vid-al11";
    await seedVideo(v1);
    await seedVideo(v2);

    // Similarity ~0.78 — inside the mentor queue band, below the merge threshold.
    const base = [1, ...Array(15).fill(0)] as number[];
    const mid = [0.78, Math.sqrt(1 - 0.78 * 0.78), ...Array(14).fill(0)] as number[];
    embedRegistry.set("Heat Input", base);
    embedRegistry.set("Thermal Energy Applied", mid);

    await syncVideoKnowledge(v1, [makeItem("concept", "Heat Input")]);
    await syncVideoKnowledge(v2, [makeItem("concept", "Thermal Energy Applied")]);

    // Both nodes exist — the ambiguous wording was NOT queued or merged.
    expect(nodeById(knowledgeNodeId("concept", "Heat Input"))).toBeDefined();
    expect(nodeById(knowledgeNodeId("concept", "Thermal Energy Applied"))).toBeDefined();
    expect(fake.tables["knowledge_candidates"] ?? []).toHaveLength(0);
  });
});

describe("recomputeKnowledgeAggregates — corroboration math & hub weights", () => {
  it("confidence equals the noisy-OR of each source video's extraction confidence", async () => {
    const [v1, v2, v3] = ["vid-n1", "vid-n2", "vid-n3"];
    await seedVideo(v1);
    await seedVideo(v2);
    await seedVideo(v3);

    const id = knowledgeNodeId("concept", "Amperage Setting");
    await syncVideoKnowledge(v1, [makeItem("concept", "Amperage Setting", { confidence: 0.5 })]);
    await syncVideoKnowledge(v2, [makeItem("concept", "Amperage Setting", { confidence: 0.4 })]);
    await syncVideoKnowledge(v3, [makeItem("concept", "Amperage Setting", { confidence: 0.8 })]);

    // noisy-OR = 1 - (1-0.5)(1-0.4)(1-0.8) = 1 - 0.5*0.6*0.2 = 0.94.
    expect(nodeById(id)!["confidence"] as number).toBeCloseTo(0.94, 10);
    expect((nodeById(id)!["meta"] as Record<string, unknown>)["sourceCount"]).toBe(3);
  });

  it("a single weak source keeps confidence exactly at its own extraction value", async () => {
    const v = "vid-solo";
    await seedVideo(v);
    const id = knowledgeNodeId("concept", "Backstep Technique");
    await syncVideoKnowledge(v, [makeItem("concept", "Backstep Technique", { confidence: 0.3 })]);

    // noisy-OR of a single source is just that source's confidence.
    expect(nodeById(id)!["confidence"] as number).toBeCloseTo(0.3, 10);
  });

  it("re-processing the same video does not inflate confidence (idempotent noisy-OR)", async () => {
    const v = "vid-replay-conf";
    await seedVideo(v);
    const id = knowledgeNodeId("concept", "Weave Bead");
    const items = [makeItem("concept", "Weave Bead", { confidence: 0.7 })];

    await syncVideoKnowledge(v, items);
    await syncVideoKnowledge(v, items);
    await syncVideoKnowledge(v, items);

    // One distinct source video, so confidence stays exactly 0.7 regardless of replays.
    expect(nodeById(id)!["confidence"] as number).toBeCloseTo(0.7, 10);
    expect((nodeById(id)!["meta"] as Record<string, unknown>)["sourceCount"]).toBe(1);
  });

  it("computes the exact timestamp union and sourceVideoIds across videos", async () => {
    const [v1, v2] = ["vid-ts1", "vid-ts2"];
    await seedVideo(v1);
    await seedVideo(v2);

    const id = knowledgeNodeId("concept", "Root Gap");
    await syncVideoKnowledge(v1, [makeItem("concept", "Root Gap", { timestamps: [30, 10] })]);
    await syncVideoKnowledge(v2, [makeItem("concept", "Root Gap", { timestamps: [20, 30] })]);

    const meta = nodeById(id)!["meta"] as Record<string, unknown>;
    // Union is de-duplicated (30 appears in both) and sorted ascending.
    expect(meta["timestamps"]).toEqual([10, 20, 30]);
    expect((meta["sourceVideoIds"] as string[]).slice().sort()).toEqual([v1, v2].sort());
    expect(meta["sourceCount"]).toBe(2);
    // Per-source records preserve each video's own timestamps.
    const sources = meta["sources"] as Array<{ videoId: string; timestamps: number[] }>;
    const byId = new Map(sources.map((s) => [s.videoId, s.timestamps]));
    expect(byId.get(v1)).toEqual([10, 30]);
    expect(byId.get(v2)).toEqual([20, 30]);
  });

  it("sets topic and competency hub-edge weights to the distinct corroborating video count", async () => {
    const [v1, v2] = ["vid-hw1", "vid-hw2"];
    await seedVideo(v1);
    await seedVideo(v2);

    const id = knowledgeNodeId("concept", "Bevel Angle");
    await syncVideoKnowledge(v1, [makeItem("concept", "Bevel Angle", { competencyCode: "W-2" })]);

    // After one video: both hub edges weigh exactly 1.
    expect(hubEdge(id, topicId(TRADE))!["weight"]).toBe(1);
    expect(hubEdge(id, compId("W-2"))!["weight"]).toBe(1);

    await syncVideoKnowledge(v2, [makeItem("concept", "Bevel Angle", { competencyCode: "W-2" })]);

    // Two distinct videos corroborate the same trade + competency → weight 2.
    expect(hubEdge(id, topicId(TRADE))!["weight"]).toBe(2);
    expect(hubEdge(id, compId("W-2"))!["weight"]).toBe(2);
  });

  it("keeps exact corroboration math when a differently-worded duplicate is embedding-merged", async () => {
    const [v1, v2] = ["vid-merge-agg1", "vid-merge-agg2"];
    await seedVideo(v1);
    await seedVideo(v2);

    // Force the two differently-worded titles to embed identically so they merge
    // via cosine similarity rather than exact/normalized-label reuse.
    const shared = defaultEmbed("__preheat_cluster__");
    embedRegistry.set("Preheat", shared);
    embedRegistry.set("Pre-Heating", shared);

    const canonicalId = knowledgeNodeId("concept", "Preheat");
    const wordedId = knowledgeNodeId("concept", "Pre-Heating");

    await syncVideoKnowledge(v1, [
      makeItem("concept", "Preheat", { confidence: 0.5, timestamps: [30, 10], competencyCode: "W-2" }),
    ]);
    await syncVideoKnowledge(v2, [
      makeItem("concept", "Pre-Heating", { confidence: 0.4, timestamps: [20, 30], competencyCode: "W-2" }),
    ]);

    // The two videos funnel onto one canonical node.
    expect(nodeById(canonicalId)).toBeDefined();
    expect(nodeById(wordedId)).toBeUndefined();
    expect(provTo(canonicalId)).toHaveLength(2);

    // Confidence is the noisy-OR of both videos' extraction confidences.
    // 1 - (1-0.5)(1-0.4) = 1 - 0.5*0.6 = 0.7.
    expect(nodeById(canonicalId)!["confidence"] as number).toBeCloseTo(0.7, 10);

    const meta = nodeById(canonicalId)!["meta"] as Record<string, unknown>;
    // Timestamp union is de-duplicated (30 appears in both) and sorted ascending.
    expect(meta["timestamps"]).toEqual([10, 20, 30]);
    expect((meta["sourceVideoIds"] as string[]).slice().sort()).toEqual([v1, v2].sort());
    expect(meta["sourceCount"]).toBe(2);

    // Both videos map the merged concept to the same trade + competency → weight 2.
    expect(hubEdge(canonicalId, topicId(TRADE))!["weight"]).toBe(2);
    expect(hubEdge(canonicalId, compId("W-2"))!["weight"]).toBe(2);
  });

  it("counts a competency once per video even if extracted multiple times in that video", async () => {
    const v = "vid-dup-in-one";
    await seedVideo(v);

    const id = knowledgeNodeId("concept", "Duty Cycle");
    // The same concept appears twice in one video's distillation output.
    await syncVideoKnowledge(v, [
      makeItem("concept", "Duty Cycle", { competencyCode: "W-2", timestamps: [5] }),
      makeItem("concept", "Duty Cycle", { competencyCode: "W-2", timestamps: [9] }),
    ]);

    // Still one distinct source video → hub-edge weight 1, not 2.
    expect(hubEdge(id, compId("W-2"))!["weight"]).toBe(1);
    expect((nodeById(id)!["meta"] as Record<string, unknown>)["sourceCount"]).toBe(1);
  });

  it("deletes a competency hub edge once no video maps the concept to it anymore", async () => {
    const v = "vid-remap";
    await seedVideo(v);

    const id = knowledgeNodeId("concept", "Shielding Gas");
    await syncVideoKnowledge(v, [makeItem("concept", "Shielding Gas", { competencyCode: "W-2" })]);
    expect(hubEdge(id, compId("W-2"))!["weight"]).toBe(1);

    // Re-process the video, now mapping the concept to a different competency.
    await syncVideoKnowledge(v, [makeItem("concept", "Shielding Gas", { competencyCode: "W-3" })]);

    // The stale W-2 hub edge drops to weight 0 and is removed; W-3 takes over.
    expect(hubEdge(id, compId("W-2"))).toBeUndefined();
    expect(hubEdge(id, compId("W-3"))!["weight"]).toBe(1);
  });

  it("drops a hub-edge weight when one of several corroborating videos is removed", async () => {
    const [v1, v2] = ["vid-drop1", "vid-drop2"];
    await seedVideo(v1);
    await seedVideo(v2);

    const id = knowledgeNodeId("concept", "Contact Tip");
    await syncVideoKnowledge(v1, [makeItem("concept", "Contact Tip", { competencyCode: "W-2" })]);
    await syncVideoKnowledge(v2, [makeItem("concept", "Contact Tip", { competencyCode: "W-2" })]);
    expect(hubEdge(id, compId("W-2"))!["weight"]).toBe(2);

    // Remove one source video; the concept survives on the other's provenance.
    fake.tables["videos"] = fake.tables["videos"].filter((r) => r["id"] !== v1);
    await removeVideoGraph(v1);

    expect(nodeById(id)).toBeDefined();
    expect(hubEdge(id, compId("W-2"))!["weight"]).toBe(1);
    expect(hubEdge(id, topicId(TRADE))!["weight"]).toBe(1);
    expect((nodeById(id)!["meta"] as Record<string, unknown>)["sourceCount"]).toBe(1);
  });
});

describe("removeVideoGraph — embedding-merged concepts reconverge on removal", () => {
  it("a merged concept drops to the surviving video's trust when one contributor is removed", async () => {
    const [v1, v2] = ["vid-unmerge1", "vid-unmerge2"];
    await seedVideo(v1);
    await seedVideo(v2);

    // Force the two differently-worded titles to embed identically so they merge
    // via cosine similarity rather than exact/normalized-label reuse.
    const shared = defaultEmbed("__preheat_cluster__");
    embedRegistry.set("Preheat", shared);
    embedRegistry.set("Pre-Heating", shared);

    const canonicalId = knowledgeNodeId("concept", "Preheat");
    const wordedId = knowledgeNodeId("concept", "Pre-Heating");

    // v1 mints the canonical node; v2's differently-worded item merges onto it.
    await syncVideoKnowledge(v1, [
      makeItem("concept", "Preheat", { confidence: 0.5, timestamps: [30, 10], competencyCode: "W-2" }),
    ]);
    await syncVideoKnowledge(v2, [
      makeItem("concept", "Pre-Heating", { confidence: 0.4, timestamps: [20, 30], competencyCode: "W-2" }),
    ]);

    // Both videos funnel onto one canonical node before removal.
    expect(nodeById(canonicalId)).toBeDefined();
    expect(nodeById(wordedId)).toBeUndefined();
    expect(provTo(canonicalId)).toHaveLength(2);
    expect((nodeById(canonicalId)!["meta"] as Record<string, unknown>)["sourceCount"]).toBe(2);

    // Remove v1 — the node's original minter — and reconverge on v2 alone.
    fake.tables["videos"] = fake.tables["videos"].filter((r) => r["id"] !== v1);
    await removeVideoGraph(v1);

    // The merged node survives on v2's provenance (still one source).
    expect(nodeById(canonicalId)).toBeDefined();
    expect(provTo(canonicalId)).toHaveLength(1);

    // Confidence collapses to v2's own extraction confidence (noisy-OR of one source).
    expect(nodeById(canonicalId)!["confidence"] as number).toBeCloseTo(0.4, 10);

    const meta = nodeById(canonicalId)!["meta"] as Record<string, unknown>;
    // Timestamps and sources reflect only the survivor now.
    expect(meta["timestamps"]).toEqual([20, 30]);
    expect(meta["sourceVideoIds"]).toEqual([v2]);
    expect(meta["sourceCount"]).toBe(1);

    // Hub-edge weights fall back to a single corroborating video.
    expect(hubEdge(canonicalId, topicId(TRADE))!["weight"]).toBe(1);
    expect(hubEdge(canonicalId, compId("W-2"))!["weight"]).toBe(1);
  });

  it("preserves reviewer verification and provenance history when one of two source videos is deleted", async () => {
    const [v1, v2] = ["vid-verify-rm1", "vid-verify-rm2"];
    await seedVideo(v1);
    await seedVideo(v2);

    // Force the two differently-worded titles to embed identically so v2's item
    // MERGES onto v1's canonical node (recording a mergedFrom entry).
    const shared = defaultEmbed("__stickout_cluster__");
    embedRegistry.set("Electrode Stickout", shared);
    embedRegistry.set("Electrode Stick-Out", shared);

    const canonicalId = knowledgeNodeId("concept", "Electrode Stickout");
    const wordedId = knowledgeNodeId("concept", "Electrode Stick-Out");

    await syncVideoKnowledge(v1, [
      makeItem("concept", "Electrode Stickout", {
        confidence: 0.5,
        timestamps: [30, 10],
        competencyCode: "W-2",
      }),
    ]);
    await syncVideoKnowledge(v2, [
      makeItem("concept", "Electrode Stick-Out", {
        confidence: 0.4,
        timestamps: [20, 30],
        competencyCode: "W-2",
      }),
    ]);

    // A reviewer verifies the merged concept (records a verificationHistory transition).
    await setNodeVerification(canonicalId, "verified");

    // Preconditions: the human + provenance state a routine deletion must preserve.
    const before = nodeById(canonicalId)!;
    const beforeMeta = before["meta"] as Record<string, unknown>;
    expect(before["verification_status"]).toBe("verified");
    const beforeHistory = beforeMeta["verificationHistory"] as Array<Record<string, unknown>>;
    expect(beforeHistory).toHaveLength(1);
    expect(beforeHistory[0]).toMatchObject({ from: "unverified", to: "verified" });
    const beforeMerged = beforeMeta["mergedFrom"] as Array<Record<string, unknown>>;
    expect(beforeMerged).toHaveLength(1);
    expect(beforeMerged[0]).toMatchObject({
      id: wordedId,
      label: "Electrode Stick-Out",
      category: "concept",
    });
    expect(provTo(canonicalId)).toHaveLength(2);
    expect(beforeMeta["sourceCount"]).toBe(2);

    // Routine deletion of ONE source video — the concept survives on the other.
    fake.tables["videos"] = fake.tables["videos"].filter((r) => r["id"] !== v1);
    await removeVideoGraph(v1);

    const after = nodeById(canonicalId)!;
    const afterMeta = after["meta"] as Record<string, unknown>;

    // The reviewer's decision is intact — deletion never wipes verification.
    expect(after["verification_status"]).toBe("verified");
    expect(afterMeta["verificationHistory"]).toEqual(beforeHistory);

    // The "why this concept exists" merge audit trail is intact too.
    expect(afterMeta["mergedFrom"]).toEqual(beforeMerged);

    // Derived corroboration correctly drops to the single surviving source:
    // confidence collapses to v2's own extraction confidence (noisy-OR of one).
    expect(after["confidence"] as number).toBeCloseTo(0.4, 10);
    expect(afterMeta["sourceVideoIds"]).toEqual([v2]);
    expect(afterMeta["sourceCount"]).toBe(1);
    expect(afterMeta["timestamps"]).toEqual([20, 30]);
    expect(provTo(canonicalId)).toHaveLength(1);

    // Hub-edge weights fall back to the single corroborating video.
    expect(hubEdge(canonicalId, topicId(TRADE))!["weight"]).toBe(1);
    expect(hubEdge(canonicalId, compId("W-2"))!["weight"]).toBe(1);

    // The merge is not undone — still exactly one canonical node, no duplicate.
    expect(nodeById(wordedId)).toBeUndefined();
    expect(nodes().filter((n) => n["id"] === canonicalId)).toHaveLength(1);
  });

  it("prunes the merged node entirely once both contributing videos are removed", async () => {
    const [v1, v2] = ["vid-unmerge-all1", "vid-unmerge-all2"];
    await seedVideo(v1);
    await seedVideo(v2);

    const shared = defaultEmbed("__interpass_cluster__");
    embedRegistry.set("Interpass Temperature", shared);
    embedRegistry.set("Inter-Pass Temp", shared);

    const canonicalId = knowledgeNodeId("concept", "Interpass Temperature");

    await syncVideoKnowledge(v1, [
      makeItem("concept", "Interpass Temperature", { confidence: 0.5, competencyCode: "W-2" }),
    ]);
    await syncVideoKnowledge(v2, [
      makeItem("concept", "Inter-Pass Temp", { confidence: 0.4, competencyCode: "W-2" }),
    ]);

    expect(nodeById(canonicalId)).toBeDefined();
    expect(provTo(canonicalId)).toHaveLength(2);

    // Remove the first contributor — node survives on the second's provenance.
    fake.tables["videos"] = fake.tables["videos"].filter((r) => r["id"] !== v1);
    await removeVideoGraph(v1);
    expect(nodeById(canonicalId)).toBeDefined();

    // Remove the last contributor — the node is orphaned and pruned entirely.
    fake.tables["videos"] = fake.tables["videos"].filter((r) => r["id"] !== v2);
    await removeVideoGraph(v2);

    expect(nodeById(canonicalId)).toBeUndefined();
    expect(provTo(canonicalId)).toHaveLength(0);
    // The concept's hub edges cascade away with the node.
    expect(hubEdge(canonicalId, topicId(TRADE))).toBeUndefined();
    expect(hubEdge(canonicalId, compId("W-2"))).toBeUndefined();
  });
});

describe("rebuildGraph — reconverges merged concepts from provenance", () => {
  it("recomputes correct trust for an embedding-merged concept after aggregates are blanked", async () => {
    const [v1, v2] = ["vid-rebuild1", "vid-rebuild2"];
    await seedVideo(v1);
    await seedVideo(v2);

    // Force the two differently-worded titles to embed identically so they merge
    // via cosine similarity rather than exact/normalized-label reuse.
    const shared = defaultEmbed("__preheat_cluster__");
    embedRegistry.set("Preheat", shared);
    embedRegistry.set("Pre-Heating", shared);

    const canonicalId = knowledgeNodeId("concept", "Preheat");
    const wordedId = knowledgeNodeId("concept", "Pre-Heating");

    // Two differently-worded videos merge onto one canonical node — the same
    // fixture as a fresh ingestion, so its aggregates are the ground truth.
    await syncVideoKnowledge(v1, [
      makeItem("concept", "Preheat", { confidence: 0.5, timestamps: [30, 10], competencyCode: "W-2" }),
    ]);
    await syncVideoKnowledge(v2, [
      makeItem("concept", "Pre-Heating", { confidence: 0.4, timestamps: [20, 30], competencyCode: "W-2" }),
    ]);

    expect(nodeById(canonicalId)).toBeDefined();
    expect(nodeById(wordedId)).toBeUndefined();
    expect(provTo(canonicalId)).toHaveLength(2);

    // Simulate a DB seeded before the Graph Intelligence layer (or corruption):
    // blank the derived confidence + meta on the node and the hub-edge weights,
    // leaving only the provenance edges intact as the source of truth.
    const node = nodeById(canonicalId)!;
    node["confidence"] = null;
    node["meta"] = {};
    hubEdge(canonicalId, topicId(TRADE))!["weight"] = 0;
    hubEdge(canonicalId, compId("W-2"))!["weight"] = 0;

    await rebuildGraph();

    // Confidence is re-derived as the noisy-OR of both videos' extraction
    // confidences: 1 - (1-0.5)(1-0.4) = 0.7 — identical to a fresh ingestion.
    expect(nodeById(canonicalId)!["confidence"] as number).toBeCloseTo(0.7, 10);

    const meta = nodeById(canonicalId)!["meta"] as Record<string, unknown>;
    // Timestamp union is de-duplicated (30 appears in both) and sorted ascending.
    expect(meta["timestamps"]).toEqual([10, 20, 30]);
    expect((meta["sourceVideoIds"] as string[]).slice().sort()).toEqual([v1, v2].sort());
    expect(meta["sourceCount"]).toBe(2);

    // Hub-edge weights are recomputed to the distinct corroborating video count.
    expect(hubEdge(canonicalId, topicId(TRADE))!["weight"]).toBe(2);
    expect(hubEdge(canonicalId, compId("W-2"))!["weight"]).toBe(2);

    // Scaffold and video nodes survive the rebuild intact.
    expect(nodeById(GRAPH_CORE_ID)).toBeDefined();
    expect(nodeById(topicId(TRADE))).toBeDefined();
    expect(nodeById(compId("W-2"))).toBeDefined();
    expect(nodeById(`video:${v1}`)).toBeDefined();
    expect(nodeById(`video:${v2}`)).toBeDefined();
    // The merge is not undone — still one canonical concept node, no duplicate.
    expect(nodeById(wordedId)).toBeUndefined();
    expect(nodes().filter((n) => n["kind"] === "concept")).toHaveLength(1);
  });

  it("preserves reviewer verification and provenance history (verification, mergedFrom, rejectedEvidence) across a rebuild", async () => {
    const [v1, v2, v3] = ["vid-preserve1", "vid-preserve2", "vid-preserve3"];
    await seedVideo(v1);
    await seedVideo(v2);
    await seedVideo(v3);

    // Force the two differently-worded titles to embed identically so v2's item
    // MERGES onto v1's canonical node (records a mergedFrom entry). v3 teaches the
    // same concept by exact label, then withdraws it to record rejectedEvidence.
    const shared = defaultEmbed("__preheat_cluster__");
    embedRegistry.set("Preheat", shared);
    embedRegistry.set("Pre-Heating", shared);

    const canonicalId = knowledgeNodeId("concept", "Preheat");
    const wordedId = knowledgeNodeId("concept", "Pre-Heating");

    await syncVideoKnowledge(v1, [
      makeItem("concept", "Preheat", { confidence: 0.5, timestamps: [30, 10], competencyCode: "W-2" }),
    ]);
    await syncVideoKnowledge(v2, [
      makeItem("concept", "Pre-Heating", { confidence: 0.4, timestamps: [20, 30], competencyCode: "W-2" }),
    ], { extractedAt: "2026-06-02T00:00:00.000Z" });
    // v3 briefly corroborates the concept too, then a re-process withdraws it —
    // this is what records a rejectedEvidence entry for the withdrawn source.
    await syncVideoKnowledge(v3, [
      makeItem("concept", "Preheat", { confidence: 0.7, competencyCode: "W-2" }),
    ]);
    await syncVideoKnowledge(v3, [makeItem("concept", "Bevel Angle")], {
      extractedAt: "2026-06-04T00:00:00.000Z",
    });

    // A reviewer verifies the concept (records a verificationHistory transition).
    await setNodeVerification(canonicalId, "verified");

    // Preconditions: the human + provenance state we expect a rebuild to preserve.
    const before = nodeById(canonicalId)!;
    const beforeMeta = before["meta"] as Record<string, unknown>;
    expect(before["verification_status"]).toBe("verified");
    const beforeHistory = beforeMeta["verificationHistory"] as Array<Record<string, unknown>>;
    expect(beforeHistory).toHaveLength(1);
    expect(beforeHistory[0]).toMatchObject({ from: "unverified", to: "verified" });
    const beforeMerged = beforeMeta["mergedFrom"] as Array<Record<string, unknown>>;
    expect(beforeMerged).toHaveLength(1);
    expect(beforeMerged[0]).toMatchObject({ id: wordedId, label: "Pre-Heating", category: "concept" });
    const beforeRejected = beforeMeta["rejectedEvidence"] as Array<Record<string, unknown>>;
    expect(beforeRejected).toHaveLength(1);
    expect(beforeRejected[0]).toMatchObject({ videoId: v3, reason: "no-longer-extracted" });
    // Only v1 + v2 currently corroborate it (v3 withdrew).
    expect(provTo(canonicalId)).toHaveLength(2);

    await rebuildGraph();

    // A rebuild recomputes aggregates but must NOT re-run distillation, so the
    // human decision and every provenance/audit record survive untouched.
    const after = nodeById(canonicalId)!;
    const afterMeta = after["meta"] as Record<string, unknown>;

    // Reviewer verification is intact.
    expect(after["verification_status"]).toBe("verified");
    expect(afterMeta["verificationHistory"]).toEqual(beforeHistory);

    // Merge records ("why this concept exists") are intact.
    expect(afterMeta["mergedFrom"]).toEqual(beforeMerged);

    // rejectedEvidence for the withdrawn source is preserved — not dropped (v3 is
    // not a current source) and not recreated (still exactly one entry).
    const afterRejected = afterMeta["rejectedEvidence"] as Array<Record<string, unknown>>;
    expect(afterRejected).toHaveLength(1);
    expect(afterRejected[0]).toMatchObject({ videoId: v3, reason: "no-longer-extracted" });

    // Derived corroboration is still correct: noisy-OR of v1 (0.5) + v2 (0.4) = 0.7.
    expect(after["confidence"] as number).toBeCloseTo(0.7, 10);
    expect((afterMeta["sourceVideoIds"] as string[]).slice().sort()).toEqual([v1, v2].sort());
    expect(afterMeta["sourceCount"]).toBe(2);
    expect(afterMeta["timestamps"]).toEqual([10, 20, 30]);

    // Hub-edge weights reflect the two corroborating videos.
    expect(hubEdge(canonicalId, topicId(TRADE))!["weight"]).toBe(2);
    expect(hubEdge(canonicalId, compId("W-2"))!["weight"]).toBe(2);

    // The merge is not undone — the Preheat cluster is still one canonical node,
    // no duplicate (Bevel Angle is a separate, legitimate concept from v3).
    expect(nodeById(wordedId)).toBeUndefined();
    expect(nodes().filter((n) => n["id"] === canonicalId)).toHaveLength(1);
  });
});

describe("rebuildGraph — mentor-taught knowledge survives a full rebuild", () => {
  const MENTOR = "bbbbbbbb-0000-0000-0000-000000000001";
  const ANSWER_1 = "22222222-0000-0000-0000-000000000001";
  const ANSWER_2 = "22222222-0000-0000-0000-000000000002";
  const mentorSourceId = `mentor:${MENTOR}`;

  it("a mentor-only concept is NOT orphan-pruned by a rebuild — mentor node, provenance, verification, and aggregates survive", async () => {
    // A mentor teaches a concept no video has ever taught (novel → created).
    const conceptId = knowledgeNodeId("concept", "Reading the Puddle by Sound");
    const outcomes = await syncMentorAnswerKnowledge(
      MENTOR,
      "Alice",
      [makeItem("concept", "Reading the Puddle by Sound", { confidence: 0.8, competencyCode: "W-2" })],
      { answerId: ANSWER_1, trade: TRADE },
    );
    expect(outcomes[0]!.outcome).toBe("created");
    expect(nodeById(conceptId)).toBeDefined();
    expect(nodeById(conceptId)!["verification_status"]).toBe("mentor_supplied");

    // A reviewer then verifies the mentor's concept.
    await setNodeVerification(conceptId, "verified");
    const beforeHistory = (nodeById(conceptId)!["meta"] as Record<string, unknown>)[
      "verificationHistory"
    ] as Array<Record<string, unknown>>;
    expect(beforeHistory).toHaveLength(1);
    expect(beforeHistory[0]).toMatchObject({ from: "mentor_supplied", to: "verified" });

    // Routine self-heal: a full rebuild re-syncs videos and prunes orphans.
    await rebuildGraph();

    // The mentor source node and its provenance edge survive — the concept is
    // corroborated, not an orphan, even though NO video teaches it.
    expect(nodeById(mentorSourceId)).toBeDefined();
    const after = nodeById(conceptId);
    expect(after).toBeDefined();
    const prov = provTo(conceptId);
    expect(prov).toHaveLength(1);
    expect(prov[0]!["source_id"]).toBe(mentorSourceId);

    // The reviewer's decision and its audit history are intact.
    expect(after!["verification_status"]).toBe("verified");
    const afterMeta = after!["meta"] as Record<string, unknown>;
    expect(afterMeta["verificationHistory"]).toEqual(beforeHistory);

    // Recomputed aggregates still reflect the mentor's contribution.
    expect(after!["confidence"] as number).toBeCloseTo(0.8, 10);
    expect(afterMeta["sourceCount"]).toBe(1);
    expect(afterMeta["sourceVideoIds"]).toEqual([mentorSourceId]);

    // Hub-edge weights count the mentor as a corroborating source.
    expect(hubEdge(conceptId, topicId(TRADE))!["weight"]).toBe(1);
    expect(hubEdge(conceptId, compId("W-2"))!["weight"]).toBe(1);
    // The mentor node stays wired under its trade topic hub.
    expect(hubEdge(topicId(TRADE), mentorSourceId)).toBeDefined();
  });

  it("a mixed video+mentor concept keeps the mentor's edge, alias, and corroboration when a rebuild recomputes blanked aggregates", async () => {
    const v = "vid-mentor-rebuild";
    await seedVideo(v);

    // Force the mentor's differently-worded answer to embed identically to the
    // video's concept so it REINFORCES the canonical node and records an alias.
    const shared = defaultEmbed("__travel_speed_cluster__");
    embedRegistry.set("Travel Speed Control", shared);
    embedRegistry.set("Pacing the Bead", shared);

    const canonicalId = knowledgeNodeId("concept", "Travel Speed Control");

    // The video mints the canonical node; the mentor reinforces it.
    await syncVideoKnowledge(v, [
      makeItem("concept", "Travel Speed Control", {
        confidence: 0.5,
        timestamps: [10, 30],
        competencyCode: "W-2",
      }),
    ]);
    const outcomes = await syncMentorAnswerKnowledge(
      MENTOR,
      "Alice",
      [makeItem("concept", "Pacing the Bead", { confidence: 0.8, competencyCode: "W-2" })],
      { answerId: ANSWER_2, trade: TRADE },
    );
    expect(outcomes[0]!.outcome).toBe("reinforced");
    expect(outcomes[0]!.canonicalId).toBe(canonicalId);

    // A reviewer verifies the mixed-provenance concept.
    await setNodeVerification(canonicalId, "verified");

    // Preconditions: one video + one mentor source, alias recorded, verified.
    const before = nodeById(canonicalId)!;
    const beforeMeta = before["meta"] as Record<string, unknown>;
    const beforeHistory = beforeMeta["verificationHistory"] as Array<Record<string, unknown>>;
    expect(before["verification_status"]).toBe("verified");
    expect(beforeMeta["aliases"]).toEqual(["Pacing the Bead"]);
    expect(provTo(canonicalId).map((e) => e["source_id"]).sort()).toEqual(
      [mentorSourceId, `video:${v}`].sort(),
    );

    // Simulate stale/corrupted derived state (e.g. a DB written before the
    // Graph Intelligence layer): blank the node aggregates and hub weights,
    // leaving only provenance edges as the source of truth.
    const node = nodeById(canonicalId)!;
    node["confidence"] = null;
    node["meta"] = {
      aliases: beforeMeta["aliases"],
      verificationHistory: beforeHistory,
    };
    hubEdge(canonicalId, topicId(TRADE))!["weight"] = 0;
    hubEdge(canonicalId, compId("W-2"))!["weight"] = 0;

    await rebuildGraph();

    // The mentor's provenance edge survived the rebuild (re-syncing the video
    // must not clobber or drop the mentor's independent corroboration).
    const prov = provTo(canonicalId);
    expect(prov.map((e) => e["source_id"]).sort()).toEqual(
      [mentorSourceId, `video:${v}`].sort(),
    );
    expect(nodeById(mentorSourceId)).toBeDefined();

    // Human state is intact: verification decision, history, and the mentor's alias.
    const after = nodeById(canonicalId)!;
    const afterMeta = after["meta"] as Record<string, unknown>;
    expect(after["verification_status"]).toBe("verified");
    expect(afterMeta["verificationHistory"]).toEqual(beforeHistory);
    expect(afterMeta["aliases"]).toEqual(["Pacing the Bead"]);

    // Confidence is re-derived as the noisy-OR of BOTH sources:
    // 1 - (1-0.5)(1-0.8) = 0.9 — the mentor's contribution is still counted.
    expect(after["confidence"] as number).toBeCloseTo(0.9, 10);
    expect(afterMeta["sourceCount"]).toBe(2);
    expect((afterMeta["sourceVideoIds"] as string[]).slice().sort()).toEqual(
      [mentorSourceId, v].sort(),
    );
    // The video's timeline is preserved; the typed mentor answer adds none.
    expect(afterMeta["timestamps"]).toEqual([10, 30]);

    // Hub-edge weights are recomputed to include the mentor corroborator.
    expect(hubEdge(canonicalId, topicId(TRADE))!["weight"]).toBe(2);
    expect(hubEdge(canonicalId, compId("W-2"))!["weight"]).toBe(2);
  });

  it("consecutive rebuilds are idempotent for mentor-backed knowledge (nothing decays or duplicates)", async () => {
    const v = "vid-mentor-rebuild2";
    await seedVideo(v);

    const mixedId = knowledgeNodeId("concept", "Tack Spacing");
    const mentorOnlyId = knowledgeNodeId("concept", "Field Fit-Up Tricks");

    // Mixed concept: video + mentor teach the exact same wording.
    await syncVideoKnowledge(v, [
      makeItem("concept", "Tack Spacing", { confidence: 0.6, timestamps: [15], competencyCode: "W-3" }),
    ]);
    await syncMentorAnswerKnowledge(
      MENTOR,
      "Alice",
      [
        makeItem("concept", "Tack Spacing", { confidence: 0.7, competencyCode: "W-3" }),
        makeItem("concept", "Field Fit-Up Tricks", { confidence: 0.9 }),
      ],
      { answerId: ANSWER_1, trade: TRADE },
    );

    const snapshot = () => ({
      mixedStatus: nodeById(mixedId)!["verification_status"],
      mixedConfidence: nodeById(mixedId)!["confidence"],
      mixedMeta: JSON.stringify(nodeById(mixedId)!["meta"]),
      mixedProv: provTo(mixedId).length,
      mentorOnlyStatus: nodeById(mentorOnlyId)!["verification_status"],
      mentorOnlyConfidence: nodeById(mentorOnlyId)!["confidence"],
      mentorOnlyProv: provTo(mentorOnlyId).length,
      mentorEdges: edges().filter((e) => e["source_id"] === mentorSourceId).length,
      nodeCount: nodes().length,
      edgeCount: edges().length,
    });

    const before = snapshot();
    expect(before.mixedStatus).toBe("mentor_supplied");
    expect(before.mixedProv).toBe(2);
    expect(before.mentorOnlyProv).toBe(1);

    await rebuildGraph();
    await rebuildGraph();

    // Two rebuilds later: identical graph — mentor knowledge neither pruned,
    // decayed, nor duplicated, and the mixed concept still counts both sources.
    expect(snapshot()).toEqual(before);
    expect(nodeById(mixedId)!["confidence"] as number).toBeCloseTo(
      1 - (1 - 0.6) * (1 - 0.7),
      10,
    );
    expect(hubEdge(mixedId, compId("W-3"))!["weight"]).toBe(2);
    expect(hubEdge(mentorOnlyId, topicId(TRADE))!["weight"]).toBe(1);
  });
});

describe("removeVideoGraph — orphan pruning", () => {
  it("prunes concepts left with zero source videos but keeps shared ones", async () => {
    const v1 = "vid-x";
    const v2 = "vid-y";
    await seedVideo(v1);
    await seedVideo(v2);

    const sharedId = knowledgeNodeId("concept", "Voltage Selection");
    const soloId = knowledgeNodeId("tool", "Jet Rod");

    await syncVideoKnowledge(v1, [
      makeItem("concept", "Voltage Selection"),
      makeItem("tool", "Jet Rod"),
    ]);
    await syncVideoKnowledge(v2, [makeItem("concept", "Voltage Selection")]);

    expect(nodeById(sharedId)).toBeDefined();
    expect(nodeById(soloId)).toBeDefined();

    // Delete video 1 (its row and its graph mirror).
    fake.tables["videos"] = fake.tables["videos"].filter((r) => r["id"] !== v1);
    await removeVideoGraph(v1);

    // The shared concept survives on video 2's provenance; the solo one is pruned.
    expect(nodeById(sharedId)).toBeDefined();
    expect(nodeById(soloId)).toBeUndefined();
    expect(provTo(sharedId)).toHaveLength(1);
    expect((nodeById(sharedId)!["meta"] as Record<string, unknown>)["sourceCount"]).toBe(1);
  });
});

describe("removeVideoGraph — mentor-backed concepts survive video deletion", () => {
  const MENTOR = "aaaaaaaa-0000-0000-0000-000000000001";
  const ANSWER_1 = "11111111-0000-0000-0000-000000000001";
  const mentorSourceId = `mentor:${MENTOR}`;

  it("deleting the only source video keeps a mentor-corroborated concept alive with verification, aliases, and mentor-only aggregates", async () => {
    const v = "vid-mentor-rm1";
    await seedVideo(v);

    // Force the mentor's differently-worded answer to embed identically to the
    // video's concept so it REINFORCES the same canonical node and records the
    // mentor's wording as an alias.
    const shared = defaultEmbed("__arc_length_cluster__");
    embedRegistry.set("Arc Length Control", shared);
    embedRegistry.set("Keeping a Tight Arc", shared);

    const canonicalId = knowledgeNodeId("concept", "Arc Length Control");

    // The video teaches the concept first (mints the canonical node).
    await syncVideoKnowledge(v, [
      makeItem("concept", "Arc Length Control", {
        confidence: 0.5,
        timestamps: [10, 30],
        competencyCode: "W-2",
      }),
    ]);

    // A mentor corroborates the SAME concept through Interview Mode, using their
    // own wording — reinforcement records the alias and a mentor provenance edge.
    const outcomes = await syncMentorAnswerKnowledge(
      MENTOR,
      "Alice",
      [makeItem("concept", "Keeping a Tight Arc", { confidence: 0.8, competencyCode: "W-2" })],
      { answerId: ANSWER_1, trade: TRADE },
    );
    expect(outcomes[0]!.outcome).toBe("reinforced");
    expect(outcomes[0]!.canonicalId).toBe(canonicalId);

    // A reviewer then verifies the concept (records a verificationHistory entry).
    await setNodeVerification(canonicalId, "verified");

    // Preconditions: mixed corroboration (one video + one mentor), verified, alias.
    const before = nodeById(canonicalId)!;
    const beforeMeta = before["meta"] as Record<string, unknown>;
    expect(before["verification_status"]).toBe("verified");
    const beforeHistory = beforeMeta["verificationHistory"] as Array<Record<string, unknown>>;
    expect(beforeHistory).toHaveLength(1);
    expect(beforeHistory[0]).toMatchObject({ from: "mentor_supplied", to: "verified" });
    expect(beforeMeta["aliases"]).toEqual(["Keeping a Tight Arc"]);
    expect(provTo(canonicalId).map((e) => e["source_id"]).sort()).toEqual(
      [mentorSourceId, `video:${v}`].sort(),
    );
    expect(beforeMeta["sourceCount"]).toBe(2);
    // Two sources (video + mentor) corroborate trade + competency → weight 2.
    expect(hubEdge(canonicalId, topicId(TRADE))!["weight"]).toBe(2);
    expect(hubEdge(canonicalId, compId("W-2"))!["weight"]).toBe(2);

    // Routine deletion of the ONLY source video.
    fake.tables["videos"] = fake.tables["videos"].filter((r) => r["id"] !== v);
    await removeVideoGraph(v);

    // The concept is NOT pruned as an orphan — the mentor's provenance edge
    // keeps it alive.
    const after = nodeById(canonicalId)!;
    expect(after).toBeDefined();
    const prov = provTo(canonicalId);
    expect(prov).toHaveLength(1);
    expect(prov[0]!["source_id"]).toBe(mentorSourceId);
    // The mentor source node itself is untouched.
    expect(nodeById(mentorSourceId)).toBeDefined();

    // The reviewer's decision and its audit history are intact.
    expect(after["verification_status"]).toBe("verified");
    const afterMeta = after["meta"] as Record<string, unknown>;
    expect(afterMeta["verificationHistory"]).toEqual(beforeHistory);

    // The mentor's recorded wording (alias) is intact.
    expect(afterMeta["aliases"]).toEqual(["Keeping a Tight Arc"]);

    // Derived corroboration reflects ONLY the mentor source now:
    // confidence collapses to the mentor's own contribution (noisy-OR of one).
    expect(after["confidence"] as number).toBeCloseTo(0.8, 10);
    expect(afterMeta["sourceCount"]).toBe(1);
    expect(afterMeta["sourceVideoIds"]).toEqual([mentorSourceId]);
    // Typed mentor answers carry no media timeline — the video's timestamps go.
    expect(afterMeta["timestamps"]).toEqual([]);
    const sources = afterMeta["sources"] as Array<Record<string, unknown>>;
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ videoId: mentorSourceId, confidence: 0.8 });

    // Hub-edge weights drop to the single surviving (mentor) corroborator.
    expect(hubEdge(canonicalId, topicId(TRADE))!["weight"]).toBe(1);
    expect(hubEdge(canonicalId, compId("W-2"))!["weight"]).toBe(1);
  });

  it("a mentor-corroborated concept keeps its mentor_supplied status when its source video is deleted (no reviewer decision)", async () => {
    const v = "vid-mentor-rm2";
    await seedVideo(v);

    const canonicalId = knowledgeNodeId("concept", "Puddle Watching");

    // Video and mentor teach the exact same wording (deterministic-id reinforce).
    await syncVideoKnowledge(v, [
      makeItem("concept", "Puddle Watching", { confidence: 0.6, timestamps: [15] }),
    ]);
    await syncMentorAnswerKnowledge(
      MENTOR,
      "Alice",
      [makeItem("concept", "Puddle Watching", { confidence: 0.7 })],
      { answerId: ANSWER_1, trade: TRADE },
    );

    // Mentor corroboration marked the node mentor_supplied (no human decision).
    expect(nodeById(canonicalId)!["verification_status"]).toBe("mentor_supplied");
    expect(provTo(canonicalId)).toHaveLength(2);

    fake.tables["videos"] = fake.tables["videos"].filter((r) => r["id"] !== v);
    await removeVideoGraph(v);

    // Survives on the mentor edge with mentor_supplied corroboration intact.
    const after = nodeById(canonicalId)!;
    expect(after).toBeDefined();
    expect(after["verification_status"]).toBe("mentor_supplied");
    const prov = provTo(canonicalId);
    expect(prov).toHaveLength(1);
    expect(prov[0]!["source_id"]).toBe(mentorSourceId);
    const meta = after["meta"] as Record<string, unknown>;
    expect(meta["sourceCount"]).toBe(1);
    expect(after["confidence"] as number).toBeCloseTo(0.7, 10);
  });
});

describe("setNodeVerification — reviewer decisions", () => {
  it("records verify/reject/reset on a distilled concept node", async () => {
    const v = "vid-verify";
    await seedVideo(v);
    const id = knowledgeNodeId("concept", "Root Pass");
    await syncVideoKnowledge(v, [makeItem("concept", "Root Pass")]);

    // New nodes default to unverified.
    expect(nodeById(id)!["verification_status"]).toBe("unverified");

    const verified = await setNodeVerification(id, "verified");
    expect(verified?.verificationStatus).toBe("verified");
    expect(nodeById(id)!["verification_status"]).toBe("verified");

    const rejected = await setNodeVerification(id, "rejected");
    expect(rejected?.verificationStatus).toBe("rejected");
    expect(nodeById(id)!["verification_status"]).toBe("rejected");

    const reset = await setNodeVerification(id, "unverified");
    expect(reset?.verificationStatus).toBe("unverified");
    expect(nodeById(id)!["verification_status"]).toBe("unverified");
  });

  it("refuses to verify scaffold nodes and unknown ids", async () => {
    const v = "vid-scaffold";
    await seedVideo(v);

    // A topic/competency/video scaffold node is not a distilled concept.
    expect(await setNodeVerification(`topic:${TRADE}`, "verified")).toBeNull();
    expect(await setNodeVerification("comp:W-2", "verified")).toBeNull();
    expect(await setNodeVerification(`video:${v}`, "verified")).toBeNull();
    expect(await setNodeVerification("k:concept:does-not-exist", "verified")).toBeNull();

    // The scaffold node is untouched (no verification_status written).
    expect(nodeById(`topic:${TRADE}`)!["verification_status"]).toBeUndefined();
  });

  it("a reviewer decision survives re-processing of the source video", async () => {
    const v = "vid-persist";
    await seedVideo(v);
    const id = knowledgeNodeId("concept", "Undercut");
    const items = [makeItem("concept", "Undercut")];
    await syncVideoKnowledge(v, items);

    await setNodeVerification(id, "verified");

    // Re-distilling the same video must preserve the human decision.
    await syncVideoKnowledge(v, items);
    expect(nodeById(id)!["verification_status"]).toBe("verified");
  });
});

describe("Knowledge Provenance Engine — every knowledge object remembers WHY it exists", () => {
  const meta = (id: string) => nodeById(id)!["meta"] as Record<string, unknown>;

  describe("extraction provenance (model + date)", () => {
    it("records the extracting model + date on provenance edges and derives them on the node", async () => {
      const v = "vid-prov";
      await seedVideo(v);
      const id = knowledgeNodeId("concept", "Duty Cycle");
      const at = "2026-06-01T00:00:00.000Z";
      await syncVideoKnowledge(v, [makeItem("concept", "Duty Cycle")], {
        model: MODELS.analysis,
        extractedAt: at,
      });

      // The provenance edge carries the extracting model + date verbatim.
      const edgeMeta = provFrom(v)[0]!["meta"] as Record<string, unknown>;
      expect(edgeMeta["model"]).toBe(MODELS.analysis);
      expect(edgeMeta["extractedAt"]).toBe(at);

      // The node derives distinct models + first/last extraction from its edges.
      const m = meta(id);
      expect(m["models"]).toEqual([MODELS.analysis]);
      expect(m["firstExtractedAt"]).toBe(at);
      expect(m["lastExtractedAt"]).toBe(at);
      const sources = m["sources"] as Array<Record<string, unknown>>;
      expect(sources[0]!["model"]).toBe(MODELS.analysis);
      expect(sources[0]!["extractedAt"]).toBe(at);
    });

    it("aggregates distinct models and the earliest/latest extraction across videos", async () => {
      const [v1, v2] = ["vid-mm1", "vid-mm2"];
      await seedVideo(v1);
      await seedVideo(v2);
      const id = knowledgeNodeId("concept", "Purge Gas");
      await syncVideoKnowledge(v1, [makeItem("concept", "Purge Gas")], {
        model: "gpt-4o-mini",
        extractedAt: "2026-05-01T00:00:00.000Z",
      });
      await syncVideoKnowledge(v2, [makeItem("concept", "Purge Gas")], {
        model: "gpt-4o",
        extractedAt: "2026-05-10T00:00:00.000Z",
      });

      const m = meta(id);
      expect((m["models"] as string[]).slice().sort()).toEqual(["gpt-4o", "gpt-4o-mini"]);
      expect(m["firstExtractedAt"]).toBe("2026-05-01T00:00:00.000Z");
      expect(m["lastExtractedAt"]).toBe("2026-05-10T00:00:00.000Z");
    });

    it("derives null extraction provenance for pre-feature edges (back-compat)", async () => {
      const v = "vid-legacy";
      await seedVideo(v);
      const id = knowledgeNodeId("concept", "Slag Inclusion");
      await syncVideoKnowledge(v, [makeItem("concept", "Slag Inclusion")], {
        model: MODELS.analysis,
      });

      // Simulate an edge written before the provenance feature existed.
      const em = provFrom(v)[0]!["meta"] as Record<string, unknown>;
      delete em["model"];
      delete em["extractedAt"];

      await rebuildGraph();

      const m = meta(id);
      expect(m["models"]).toEqual([]);
      expect(m["firstExtractedAt"]).toBeNull();
      expect(m["lastExtractedAt"]).toBeNull();
    });
  });

  describe("confidence history", () => {
    it("appends a point only when the derived confidence changes", async () => {
      const [v1, v2] = ["vid-ch1", "vid-ch2"];
      await seedVideo(v1);
      await seedVideo(v2);
      const id = knowledgeNodeId("concept", "Wire Feed Speed");

      await syncVideoKnowledge(v1, [makeItem("concept", "Wire Feed Speed", { confidence: 0.6 })]);
      let history = meta(id)["confidenceHistory"] as Array<Record<string, unknown>>;
      expect(history).toHaveLength(1);
      expect(history[0]!["confidence"]).toBeCloseTo(0.6, 10);

      // A second corroborating video raises the noisy-OR confidence → new point.
      await syncVideoKnowledge(v2, [makeItem("concept", "Wire Feed Speed", { confidence: 0.6 })]);
      history = meta(id)["confidenceHistory"] as Array<Record<string, unknown>>;
      expect(history).toHaveLength(2);
      expect(history[1]!["confidence"] as number).toBeGreaterThan(0.6);
      expect(history[1]!["sourceCount"]).toBe(2);
    });

    it("does not grow the confidence log on idempotent replays", async () => {
      const v = "vid-ch-replay";
      await seedVideo(v);
      const id = knowledgeNodeId("concept", "Stringer Bead");
      const items = [makeItem("concept", "Stringer Bead", { confidence: 0.7 })];

      await syncVideoKnowledge(v, items);
      await syncVideoKnowledge(v, items);
      await syncVideoKnowledge(v, items);

      expect(meta(id)["confidenceHistory"]).toHaveLength(1);
    });

    it("a full rebuild appends nothing to the confidence log", async () => {
      const v = "vid-ch-rebuild";
      await seedVideo(v);
      const id = knowledgeNodeId("concept", "Tack Weld");
      await syncVideoKnowledge(v, [makeItem("concept", "Tack Weld", { confidence: 0.55 })]);
      expect(meta(id)["confidenceHistory"]).toHaveLength(1);

      await rebuildGraph();
      await rebuildGraph();

      expect(meta(id)["confidenceHistory"]).toHaveLength(1);
    });
  });

  describe("verification history", () => {
    it("appends a transition only when the decision changes (no reviewer identity)", async () => {
      const v = "vid-vh";
      await seedVideo(v);
      const id = knowledgeNodeId("concept", "Fusion");
      await syncVideoKnowledge(v, [makeItem("concept", "Fusion")]);

      await setNodeVerification(id, "verified");
      await setNodeVerification(id, "verified"); // re-affirm — no new entry
      await setNodeVerification(id, "rejected");

      const history = meta(id)["verificationHistory"] as Array<Record<string, unknown>>;
      expect(history).toHaveLength(2);
      expect(history[0]).toMatchObject({ from: "unverified", to: "verified" });
      expect(history[1]).toMatchObject({ from: "verified", to: "rejected" });
      // Reviewer identity is intentionally never recorded here.
      expect(history[0]!["reviewer"]).toBeUndefined();
      expect(history[0]!["at"]).toEqual(expect.any(String));
    });

    it("preserves verification history across re-processing of the source video", async () => {
      const v = "vid-vh-persist";
      await seedVideo(v);
      const id = knowledgeNodeId("concept", "Spatter");
      const items = [makeItem("concept", "Spatter")];
      await syncVideoKnowledge(v, items);

      await setNodeVerification(id, "verified");
      expect(meta(id)["verificationHistory"]).toHaveLength(1);

      await syncVideoKnowledge(v, items);
      await rebuildGraph();

      expect(nodeById(id)!["verification_status"]).toBe("verified");
      expect(meta(id)["verificationHistory"]).toHaveLength(1);
    });
  });

  describe("merged-concept records", () => {
    it("records the merged-in identity when a differently-worded concept collapses onto a node", async () => {
      const [v1, v2] = ["vid-mf1", "vid-mf2"];
      await seedVideo(v1);
      await seedVideo(v2);

      const shared = defaultEmbed("__travel_angle_cluster__");
      embedRegistry.set("Travel Angle", shared);
      embedRegistry.set("Drag Angle", shared);

      const canonicalId = knowledgeNodeId("concept", "Travel Angle");
      const mergedId = knowledgeNodeId("concept", "Drag Angle");

      await syncVideoKnowledge(v1, [makeItem("concept", "Travel Angle")]);
      await syncVideoKnowledge(v2, [makeItem("concept", "Drag Angle")], {
        extractedAt: "2026-06-02T00:00:00.000Z",
      });

      const mergedFrom = meta(canonicalId)["mergedFrom"] as Array<Record<string, unknown>>;
      expect(mergedFrom).toHaveLength(1);
      expect(mergedFrom[0]).toMatchObject({ id: mergedId, label: "Drag Angle", category: "concept" });
      expect(mergedFrom[0]!["at"]).toBe("2026-06-02T00:00:00.000Z");
    });

    it("does not record a merge when the same concept is simply re-extracted (identity, not merge)", async () => {
      const v = "vid-noomerge";
      await seedVideo(v);
      const id = knowledgeNodeId("concept", "Keyhole");
      await syncVideoKnowledge(v, [makeItem("concept", "Keyhole")]);

      expect(meta(id)["mergedFrom"]).toEqual([]);
    });
  });

  describe("rejected evidence", () => {
    it("records withdrawn corroboration on a surviving node, once, and clears it on re-teach", async () => {
      const [v1, v2] = ["vid-re1", "vid-re2"];
      await seedVideo(v1);
      await seedVideo(v2);
      const conceptB = knowledgeNodeId("concept", "Whip Motion");

      // Both videos teach concept B; v1 also teaches an unrelated concept A.
      await syncVideoKnowledge(v1, [
        makeItem("concept", "Whip Motion"),
        makeItem("concept", "Weave Width"),
      ]);
      await syncVideoKnowledge(v2, [makeItem("concept", "Whip Motion")]);
      expect(meta(conceptB)["rejectedEvidence"]).toEqual([]);

      // v1 is re-processed and no longer extracts B; B survives on v2's provenance.
      await syncVideoKnowledge(v1, [makeItem("concept", "Weave Width")], {
        extractedAt: "2026-06-03T00:00:00.000Z",
      });
      let rejected = meta(conceptB)["rejectedEvidence"] as Array<Record<string, unknown>>;
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toMatchObject({ videoId: "vid-re1", reason: "no-longer-extracted" });

      // Replaying the same reduced distillation must not duplicate the rejection.
      await syncVideoKnowledge(v1, [makeItem("concept", "Weave Width")]);
      expect(meta(conceptB)["rejectedEvidence"]).toHaveLength(1);

      // Re-teaching B from v1 reconciles the rejection away (evidence restored).
      await syncVideoKnowledge(v1, [
        makeItem("concept", "Whip Motion"),
        makeItem("concept", "Weave Width"),
      ]);
      expect(meta(conceptB)["rejectedEvidence"]).toEqual([]);
    });
  });
});

describe("mentor withdrawal — removeMentorGraph / withdrawMentor", () => {
  const MENTOR = "cccccccc-0000-0000-0000-000000000001";
  const MENTOR_B = "cccccccc-0000-0000-0000-000000000002";
  const ANSWER_1 = "33333333-0000-0000-0000-000000000001";
  const ANSWER_B1 = "33333333-0000-0000-0000-000000000002";
  const SESSION_1 = "44444444-0000-0000-0000-000000000001";
  const mentorSourceId = `mentor:${MENTOR}`;

  const candidates = () => fake.tables["knowledge_candidates"] ?? [];

  /** Seed the interview-side rows the person's withdrawal must erase. */
  function seedMentorRows(profileId: string, sessionId: string, answerIds: string[]): void {
    fake.tables["mentor_profiles"] ??= [];
    fake.tables["interview_sessions"] ??= [];
    fake.tables["interview_answers"] ??= [];
    fake.tables["mentor_profiles"]!.push({ id: profileId, name: "Alice", trade: TRADE });
    fake.tables["interview_sessions"]!.push({
      id: sessionId,
      mentor_profile_id: profileId,
      status: "completed",
    });
    for (const answerId of answerIds) {
      fake.tables["interview_answers"]!.push({
        id: answerId,
        session_id: sessionId,
        mentor_profile_id: profileId,
        answer_text: "verbatim mentor wisdom",
      });
    }
  }

  it("retains a video-corroborated concept: aggregates collapse to the video's evidence, verification and aliases survive, mentor footprint is gone", async () => {
    const v = "vid-withdraw-1";
    await seedVideo(v);
    const canonicalId = knowledgeNodeId("concept", "Tack Spacing");

    // Video teaches the concept; the mentor corroborates it with their OWN
    // wording (registered as semantically identical), so an alias is recorded.
    embedRegistry.set("Tack Spacing", defaultEmbed("shared-tack-vector"));
    embedRegistry.set("Tack Gapping", defaultEmbed("shared-tack-vector"));
    await syncVideoKnowledge(v, [
      makeItem("concept", "Tack Spacing", { confidence: 0.6, timestamps: [15], competencyCode: "W-3" }),
    ]);
    const outcomes = await syncMentorAnswerKnowledge(
      MENTOR,
      "Alice",
      [makeItem("concept", "Tack Gapping", { confidence: 0.7, competencyCode: "W-3" })],
      { answerId: ANSWER_1, trade: TRADE },
    );
    expect(outcomes[0]!.outcome).toBe("reinforced");
    expect(outcomes[0]!.canonicalId).toBe(canonicalId);

    // A human reviewer verifies the concept before the mentor withdraws.
    await setNodeVerification(canonicalId, "verified");

    // Sanity: both sources are currently counted.
    const beforeMeta = nodeById(canonicalId)!["meta"] as Record<string, unknown>;
    expect(beforeMeta["sourceCount"]).toBe(2);
    expect(nodeById(canonicalId)!["confidence"] as number).toBeCloseTo(0.88, 10);

    const result = await removeMentorGraph(MENTOR);
    expect(result.retainedConceptIds).toEqual([canonicalId]);
    expect(result.archivedConceptIds).toEqual([]);

    // The concept SURVIVES on the video's evidence, aggregates honestly reduced.
    const after = nodeById(canonicalId)!;
    const afterMeta = after["meta"] as Record<string, unknown>;
    expect(after["confidence"] as number).toBeCloseTo(0.6, 10);
    expect(afterMeta["sourceCount"]).toBe(1);
    expect(afterMeta["sourceVideoIds"]).toEqual([v]);
    expect(afterMeta["timestamps"]).toEqual([15]);
    expect(hubEdge(canonicalId, topicId(TRADE))!["weight"]).toBe(1);
    expect(hubEdge(canonicalId, compId("W-3"))!["weight"]).toBe(1);

    // Human verification is untouched (verified is a reviewer decision, not
    // mentor-derived), and the mentor-taught alias STAYS — it is an
    // unattributed alternate wording the community still searches by.
    expect(after["verification_status"]).toBe("verified");
    expect((afterMeta["aliases"] as string[]) ?? []).toContain("Tack Gapping");

    // The mentor's footprint is fully gone: node, provenance, hub edges.
    expect(nodeById(mentorSourceId)).toBeUndefined();
    expect(edges().filter((e) => e["source_id"] === mentorSourceId)).toHaveLength(0);
    expect(provTo(canonicalId)).toHaveLength(1);
    expect(provTo(canonicalId)[0]!["source_id"]).toBe(`video:${v}`);

    // Nothing was archived — the concept is alive, not a candidate.
    expect(candidates()).toHaveLength(0);
  });

  it("demotes mentor_supplied to unverified when the LAST mentor leaves, but keeps it while another mentor still corroborates", async () => {
    const conceptId = knowledgeNodeId("concept", "Ground Clamp Placement");

    // Two mentors independently teach the same concept.
    await syncMentorAnswerKnowledge(
      MENTOR,
      "Alice",
      [makeItem("concept", "Ground Clamp Placement", { confidence: 0.7, competencyCode: "W-2" })],
      { answerId: ANSWER_1, trade: TRADE },
    );
    const second = await syncMentorAnswerKnowledge(
      MENTOR_B,
      "Bob",
      [makeItem("concept", "Ground Clamp Placement", { confidence: 0.8, competencyCode: "W-2" })],
      { answerId: ANSWER_B1, trade: TRADE },
    );
    expect(second[0]!.outcome).toBe("reinforced");

    // Mentor A withdraws: the concept survives on B's corroboration and KEEPS
    // mentor_supplied — a mentor still stands behind it.
    const first = await removeMentorGraph(MENTOR);
    expect(first.retainedConceptIds).toEqual([conceptId]);
    expect(first.archivedConceptIds).toEqual([]);
    const mid = nodeById(conceptId)!;
    expect(mid["verification_status"]).toBe("mentor_supplied");
    expect((mid["meta"] as Record<string, unknown>)["sourceCount"]).toBe(1);
    expect(mid["confidence"] as number).toBeCloseTo(0.8, 10);
    expect(provTo(conceptId)).toHaveLength(1);
    expect(provTo(conceptId)[0]!["source_id"]).toBe(`mentor:${MENTOR_B}`);

    // Add video evidence, then withdraw mentor B: the concept survives on the
    // video but no mentor is left — mentor_supplied silently falls back to
    // unverified (system-derived status, no history entry).
    const v = "vid-withdraw-2";
    await seedVideo(v);
    await syncVideoKnowledge(v, [
      makeItem("concept", "Ground Clamp Placement", { confidence: 0.5, timestamps: [30], competencyCode: "W-2" }),
    ]);
    const secondRemoval = await removeMentorGraph(MENTOR_B);
    expect(secondRemoval.retainedConceptIds).toEqual([conceptId]);
    const after = nodeById(conceptId)!;
    expect(after["verification_status"]).toBe("unverified");
    const history = ((after["meta"] as Record<string, unknown>)["verificationHistory"] ?? []) as unknown[];
    expect(history).toHaveLength(0);
    expect(after["confidence"] as number).toBeCloseTo(0.5, 10);
  });

  it("demotes a mentor-only concept into an attribution-free archived candidate, replay-safe", async () => {
    const conceptId = knowledgeNodeId("concept", "Reading Heat by Color");
    await syncMentorAnswerKnowledge(
      MENTOR,
      "Alice",
      [
        makeItem("concept", "Reading Heat by Color", {
          confidence: 0.9,
          competencyCode: "W-2",
          description: "Judge base-metal temperature by its color bands.",
        }),
      ],
      { answerId: ANSWER_1, trade: TRADE },
    );
    expect(nodeById(conceptId)).toBeDefined();

    const result = await removeMentorGraph(MENTOR);
    expect(result.retainedConceptIds).toEqual([]);
    expect(result.archivedConceptIds).toEqual([conceptId]);

    // OUT of the live graph entirely — node and every edge that touched it.
    expect(nodeById(conceptId)).toBeUndefined();
    expect(
      edges().filter((e) => e["source_id"] === conceptId || e["target_id"] === conceptId),
    ).toHaveLength(0);
    expect(nodeById(mentorSourceId)).toBeUndefined();

    // The archived candidate preserves the CONTENT with zero attribution.
    expect(candidates()).toHaveLength(1);
    const arch = candidates()[0]!;
    expect(arch["id"]).toBe(`arch:${conceptId}`);
    expect(arch["status"]).toBe("archived");
    expect(arch["title"]).toBe("Reading Heat by Color");
    expect(arch["description"]).toBe("Judge base-metal temperature by its color bands.");
    expect(arch["category"]).toBe("concept");
    expect(arch["trade"]).toBe(TRADE);
    expect(arch["competency_code"]).toBe("W-2");
    expect(arch["confidence"] as number).toBeCloseTo(0.9, 10);
    expect(arch["mentor_profile_id"]).toBeNull();
    expect(arch["mentor_name"]).toBeNull();
    expect(arch["answer_id"]).toBeNull();
    expect(arch["session_id"]).toBeNull();

    // Replaying the removal converges: no duplicate row, no status reset.
    const replay = await removeMentorGraph(MENTOR);
    expect(replay.retainedConceptIds).toEqual([]);
    expect(replay.archivedConceptIds).toEqual([]);
    expect(candidates()).toHaveLength(1);
  });

  it("withdrawMentor erases the person: profile/sessions/answers gone, pending candidates deleted, resolved candidates scrubbed but auditable; replay is not_found", async () => {
    seedMentorRows(MENTOR, SESSION_1, [ANSWER_1]);

    // Graph: one video-shared concept (retained) + one mentor-only (archived).
    const v = "vid-withdraw-3";
    await seedVideo(v);
    const sharedId = knowledgeNodeId("concept", "Travel Speed Control");
    await syncVideoKnowledge(v, [
      makeItem("concept", "Travel Speed Control", { confidence: 0.6, timestamps: [10], competencyCode: "W-3" }),
    ]);
    await syncMentorAnswerKnowledge(
      MENTOR,
      "Alice",
      [
        makeItem("concept", "Travel Speed Control", { confidence: 0.7, competencyCode: "W-3" }),
        makeItem("concept", "Stick Whip Timing", { confidence: 0.8 }),
      ],
      { answerId: ANSWER_1, trade: TRADE },
    );

    // Candidates: one still pending (deleted outright — unresolvable once the
    // verbatim answers are gone) and one already resolved (kept as an audit
    // record, but every mentor-identifying field is scrubbed).
    fake.tables["knowledge_candidates"] ??= [];
    fake.tables["knowledge_candidates"]!.push(
      {
        id: `cand:${ANSWER_1}:k:concept:half-match`,
        status: "pending",
        title: "Half Match",
        category: "concept",
        mentor_profile_id: MENTOR,
        mentor_name: "Alice",
        answer_id: ANSWER_1,
        session_id: SESSION_1,
        best_matches: [],
      },
      {
        id: `cand:${ANSWER_1}:k:concept:old-accepted`,
        status: "accepted",
        title: "Old Accepted",
        category: "concept",
        mentor_profile_id: MENTOR,
        mentor_name: "Alice",
        answer_id: ANSWER_1,
        session_id: SESSION_1,
        best_matches: [],
        resolved_target_id: sharedId,
        resolution_reason: null,
        resolved_at: "2026-06-01T00:00:00.000Z",
      },
    );

    const result = await withdrawMentor(MENTOR);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.summary).toEqual({
      mentorProfileId: MENTOR,
      conceptsRetained: 1,
      conceptsArchived: 1,
      candidatesDeleted: 1,
      candidatesScrubbed: 1,
    });

    // The person is fully erased: profile, session, verbatim answers.
    expect(fake.tables["mentor_profiles"]).toHaveLength(0);
    expect(fake.tables["interview_sessions"]).toHaveLength(0);
    expect(fake.tables["interview_answers"]).toHaveLength(0);

    // Pending candidate is gone; resolved candidate survives scrubbed.
    const remaining = candidates();
    const pending = remaining.find((c) => c["status"] === "pending");
    expect(pending).toBeUndefined();
    const resolved = remaining.find((c) => c["status"] === "accepted")!;
    expect(resolved["mentor_profile_id"]).toBeNull();
    expect(resolved["mentor_name"]).toBeNull();
    expect(resolved["answer_id"]).toBeNull();
    expect(resolved["session_id"]).toBeNull();
    expect(resolved["resolved_target_id"]).toBe(sharedId);
    expect(resolved["resolved_at"]).toBe("2026-06-01T00:00:00.000Z");

    // Graph outcomes match the summary: shared retained, mentor-only archived.
    expect(nodeById(sharedId)).toBeDefined();
    expect(nodeById(sharedId)!["confidence"] as number).toBeCloseTo(0.6, 10);
    expect(remaining.find((c) => c["status"] === "archived")).toBeDefined();

    // Replaying a completed withdrawal is a clean not-found, and nothing moves.
    const replay = await withdrawMentor(MENTOR);
    expect(replay).toEqual({ ok: false, code: "not_found" });
    expect(candidates()).toHaveLength(2);
  });

  it("previewMentorWithdrawal projects exactly what withdrawMentor does — counts and archived-concept names match, and the preview writes nothing", async () => {
    seedMentorRows(MENTOR, SESSION_1, [ANSWER_1]);

    // A deliberate MIX so retained/archived are both non-trivial:
    //  - "Travel Speed Control": taught by a video AND the mentor -> RETAINED.
    //  - "Stick Whip Timing" + "Reading Heat by Color": mentor-only -> ARCHIVED.
    const v = "vid-preview-parity";
    await seedVideo(v);
    const sharedId = knowledgeNodeId("concept", "Travel Speed Control");
    await syncVideoKnowledge(v, [
      makeItem("concept", "Travel Speed Control", { confidence: 0.6, timestamps: [10], competencyCode: "W-3" }),
    ]);
    await syncMentorAnswerKnowledge(
      MENTOR,
      "Alice",
      [
        makeItem("concept", "Travel Speed Control", { confidence: 0.7, competencyCode: "W-3" }),
        makeItem("concept", "Stick Whip Timing", { confidence: 0.8 }),
        makeItem("concept", "Reading Heat by Color", { confidence: 0.9, competencyCode: "W-2" }),
      ],
      { answerId: ANSWER_1, trade: TRADE },
    );

    // Candidates owned by the mentor: one pending (would be deleted), one
    // resolved (would be scrubbed but audited).
    fake.tables["knowledge_candidates"] ??= [];
    fake.tables["knowledge_candidates"]!.push(
      {
        id: `cand:${ANSWER_1}:k:concept:half-match`,
        status: "pending",
        title: "Half Match",
        category: "concept",
        mentor_profile_id: MENTOR,
        mentor_name: "Alice",
        answer_id: ANSWER_1,
        session_id: SESSION_1,
        best_matches: [],
      },
      {
        id: `cand:${ANSWER_1}:k:concept:old-accepted`,
        status: "accepted",
        title: "Old Accepted",
        category: "concept",
        mentor_profile_id: MENTOR,
        mentor_name: "Alice",
        answer_id: ANSWER_1,
        session_id: SESSION_1,
        best_matches: [],
        resolved_target_id: sharedId,
        resolved_at: "2026-06-01T00:00:00.000Z",
      },
    );

    // Snapshot the whole graph + candidate state so we can prove the preview is
    // a pure read (no drift can hide behind a mutation the preview performed).
    // The preview writes nothing, so a plain stable-sorted JSON dump suffices.
    const dump = (rows: Record<string, unknown>[]): string =>
      JSON.stringify([...rows].sort((a, b) => String(a["id"]).localeCompare(String(b["id"]))));
    const beforeNodes = dump(nodes());
    const beforeEdges = dump(edges());
    const beforeCandidates = dump(candidates());

    const previewResult = await previewMentorWithdrawal(MENTOR);
    expect(previewResult.ok).toBe(true);
    if (!previewResult.ok) throw new Error("unreachable");
    const { preview } = previewResult;

    // The preview must not have touched anything.
    expect(dump(nodes())).toBe(beforeNodes);
    expect(dump(edges())).toBe(beforeEdges);
    expect(dump(candidates())).toBe(beforeCandidates);

    // Preview projects: 1 retained, 2 archived, 1 pending deleted, 1 scrubbed,
    // with archived concepts listed by label (sorted).
    expect(preview.conceptsRetained).toBe(1);
    expect(preview.conceptsArchived).toBe(2);
    expect(preview.candidatesDeleted).toBe(1);
    expect(preview.candidatesScrubbed).toBe(1);
    const previewArchivedLabels = preview.archivedConcepts.map((c) => c.label);
    expect(previewArchivedLabels).toEqual(["Reading Heat by Color", "Stick Whip Timing"]);

    // Now do the REAL withdrawal and demand parity with the preview.
    const result = await withdrawMentor(MENTOR);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    // Every count the preview promised equals the summary the action returns.
    expect(result.summary.conceptsRetained).toBe(preview.conceptsRetained);
    expect(result.summary.conceptsArchived).toBe(preview.conceptsArchived);
    expect(result.summary.candidatesDeleted).toBe(preview.candidatesDeleted);
    expect(result.summary.candidatesScrubbed).toBe(preview.candidatesScrubbed);

    // The concepts the preview named as archived are exactly the ones that
    // actually left the live graph (now attribution-free archived candidates).
    const actualArchivedLabels = candidates()
      .filter((c) => c["status"] === "archived")
      .map((c) => c["title"] as string)
      .sort((a, b) => a.localeCompare(b));
    expect(actualArchivedLabels).toEqual(previewArchivedLabels);

    // And the retained concept is genuinely still alive.
    expect(nodeById(sharedId)).toBeDefined();
  });

  it("a mid-flight failure leaves the withdrawal retryable — the retry converges to the same end state", async () => {
    seedMentorRows(MENTOR, SESSION_1, [ANSWER_1]);
    const conceptId = knowledgeNodeId("concept", "Arc Blow Workarounds");
    await syncMentorAnswerKnowledge(
      MENTOR,
      "Alice",
      [makeItem("concept", "Arc Blow Workarounds", { confidence: 0.8, competencyCode: "W-2" })],
      { answerId: ANSWER_1, trade: TRADE },
    );

    // Inject a crash at the FINAL step: the mentor_profiles delete. Everything
    // before it (graph re-evaluation, candidate cleanup) has already run.
    const origFrom = fake.from.bind(fake);
    const spy = vi.spyOn(fake, "from").mockImplementation((table: string) => {
      const builder = origFrom(table);
      if (table === "mentor_profiles") {
        builder.delete = () => {
          throw new Error("injected crash before profile deletion");
        };
      }
      return builder;
    });
    try {
      await expect(withdrawMentor(MENTOR)).rejects.toThrow("injected crash");
    } finally {
      spy.mockRestore();
    }

    // The profile row survived the crash, so the withdrawal is retryable (a
    // replay is NOT yet not_found) even though the graph work already ran.
    expect(fake.tables["mentor_profiles"]).toHaveLength(1);
    expect(nodeById(conceptId)).toBeUndefined();
    expect(candidates()).toHaveLength(1);

    // The retry converges: idempotent graph/candidate steps are no-ops, the
    // profile finally goes, and the archived snapshot is not duplicated.
    const retry = await withdrawMentor(MENTOR);
    expect(retry.ok).toBe(true);
    if (!retry.ok) throw new Error("unreachable");
    expect(retry.summary.conceptsRetained).toBe(0);
    expect(retry.summary.conceptsArchived).toBe(0);
    expect(fake.tables["mentor_profiles"]).toHaveLength(0);
    expect(fake.tables["interview_sessions"]).toHaveLength(0);
    expect(fake.tables["interview_answers"]).toHaveLength(0);
    expect(candidates()).toHaveLength(1);
    expect(candidates()[0]!["id"]).toBe(`arch:${conceptId}`);
    expect(candidates()[0]!["status"]).toBe("archived");
  });
});
