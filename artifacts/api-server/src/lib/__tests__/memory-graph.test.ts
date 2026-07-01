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
  removeVideoGraph,
  rebuildGraph,
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
