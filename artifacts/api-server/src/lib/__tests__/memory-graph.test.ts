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

import { fake, embedRegistry, defaultEmbed, resetMocks } from "./mocks.js";
import {
  ensureBaseGraph,
  syncVideoGraph,
  syncVideoKnowledge,
  removeVideoGraph,
  knowledgeNodeId,
  setNodeVerification,
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
