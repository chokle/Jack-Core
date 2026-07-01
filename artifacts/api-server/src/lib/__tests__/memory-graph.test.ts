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
