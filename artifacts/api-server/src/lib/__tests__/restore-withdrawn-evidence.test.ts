/**
 * Guard tests for restoreWithdrawnEvidence — the admin action behind the
 * Provenance panel's "Dismiss" button. A `rejectedEvidence` entry is recorded
 * automatically when a re-processed video stops corroborating a concept it once
 * did; the concept survives because it still has another live source. These
 * tests drive a REAL drop (two videos teach one concept, then one re-processes
 * without it), then assert the reviewer action clears exactly that entry, is
 * idempotent, leaves the concept and its remaining source intact, and refuses a
 * non-knowledge / missing node.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../supabase.js", async () => {
  const m = await import("./mocks.js");
  return { supabase: m.fake };
});

vi.mock("../openai.js", async () => {
  const m = await import("./mocks.js");
  return { createEmbedding: m.createEmbedding, MODELS: m.MODELS, openai: m.openai };
});

import { fake, resetMocks } from "./mocks.js";
import {
  ensureBaseGraph,
  syncVideoGraph,
  syncVideoKnowledge,
  knowledgeNodeId,
  restoreWithdrawnEvidence,
} from "../memory-graph.js";
import type { AtomicKnowledge, KnowledgeCategory } from "../distillation.js";

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

async function seedVideo(id: string): Promise<void> {
  fake.tables["videos"].push({
    id,
    title: `Video ${id}`,
    trade: TRADE,
    status: "ready",
    description: null,
    competency_codes: [],
    created_at: new Date().toISOString(),
    updated_at: null,
  });
  await syncVideoGraph(id);
}

const nodes = () => fake.tables["knowledge_nodes"];
const nodeById = (id: string) => nodes().find((n) => n["id"] === id);
const rejectedOf = (id: string) =>
  ((nodeById(id)!["meta"] as Record<string, unknown>)["rejectedEvidence"] as
    | Array<Record<string, unknown>>
    | undefined) ?? [];

beforeEach(async () => {
  resetMocks();
  fake.tables["competencies"].push({
    code: "W-2",
    name: "Shielded Metal Arc Welding",
    trade: TRADE,
    description: null,
  });
  await ensureBaseGraph();
});

/**
 * Two videos teach one concept; then v1 re-processes WITHOUT it. The concept
 * survives on v2 and records a withdrawn-evidence entry for v1. Returns ids.
 */
async function withdrawOne(): Promise<{ conceptId: string; v1: string; v2: string }> {
  const v1 = "vid-a";
  const v2 = "vid-b";
  await seedVideo(v1);
  await seedVideo(v2);
  const conceptId = knowledgeNodeId("concept", "Root Opening");

  await syncVideoKnowledge(v1, [makeItem("concept", "Root Opening", { timestamps: [5] })]);
  await syncVideoKnowledge(v2, [makeItem("concept", "Root Opening", { timestamps: [9] })]);

  // v1 re-processes and no longer extracts the concept (distills something else).
  await syncVideoKnowledge(v1, [makeItem("hazard", "Arc Blow", { timestamps: [3] })]);

  const rejected = rejectedOf(conceptId);
  expect(rejected.map((r) => r["videoId"])).toContain(v1);
  return { conceptId, v1, v2 };
}

describe("restoreWithdrawnEvidence", () => {
  it("clears exactly the reviewed entry and leaves the concept + its source intact", async () => {
    const { conceptId, v1, v2 } = await withdrawOne();

    const node = await restoreWithdrawnEvidence(conceptId, v1);

    expect(node).not.toBeNull();
    expect(node!.id).toBe(conceptId);
    // The withdrawn-evidence note for v1 is gone...
    expect(rejectedOf(conceptId).some((r) => r["videoId"] === v1)).toBe(false);
    // ...and the concept is still alive, corroborated by v2.
    const meta = nodeById(conceptId)!["meta"] as Record<string, unknown>;
    expect((meta["sourceVideoIds"] as string[]) ?? []).toContain(v2);
    expect(meta["sourceCount"]).toBe(1);
  });

  it("is an idempotent no-op for an already-cleared / unknown video", async () => {
    const { conceptId, v1 } = await withdrawOne();

    await restoreWithdrawnEvidence(conceptId, v1);
    // Second call (entry already gone) and an unknown video both succeed unchanged.
    const again = await restoreWithdrawnEvidence(conceptId, v1);
    const unknown = await restoreWithdrawnEvidence(conceptId, "does-not-exist");

    expect(again).not.toBeNull();
    expect(unknown).not.toBeNull();
    expect(rejectedOf(conceptId)).toHaveLength(0);
  });

  it("returns null for a missing node", async () => {
    const missing = await restoreWithdrawnEvidence(knowledgeNodeId("concept", "Nope"), "vid-x");
    expect(missing).toBeNull();
  });

  it("returns null for a non-knowledge node (e.g. a video scaffold node)", async () => {
    const v = "vid-scaffold";
    await seedVideo(v);
    const result = await restoreWithdrawnEvidence(`video:${v}`, "vid-x");
    expect(result).toBeNull();
  });
});
