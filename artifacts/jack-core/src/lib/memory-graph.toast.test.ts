import { describe, expect, it } from "vitest";
import { computeGraphDelta, isRecentGrowthNode, type GraphModel, type MemoryNode } from "./memory-graph";

function node(createdAt?: string, firstExtractedAt?: string): MemoryNode {
  return {
    id: "k:procedure:test",
    kind: "procedure",
    label: "Test",
    color: [255, 100, 0],
    meta: { createdAt, firstExtractedAt },
  } as MemoryNode;
}

describe("growth toast freshness", () => {
  const snapshot = "2026-07-12T20:00:00.000Z";

  it("accepts knowledge created in the current ingestion window", () => {
    expect(isRecentGrowthNode(node("2026-07-12T19:59:45.000Z"), snapshot)).toBe(true);
    expect(isRecentGrowthNode(node(undefined, "2026-07-12T19:59:45.000Z"), snapshot)).toBe(true);
  });

  it("rejects week-old and undated placeholder knowledge", () => {
    expect(isRecentGrowthNode(node("2026-07-05T20:00:00.000Z"), snapshot)).toBe(false);
    expect(isRecentGrowthNode(node(), snapshot)).toBe(false);
  });

  it("reports a newly polled persisted knowledge node for a toast", () => {
    const empty = { topics: [], nodes: [], edges: [], degree: {}, counts: { nodes: 0, connections: 0, topics: 0, videos: 0, knowledge: 0 } } satisfies GraphModel;
    const freshNode = node(undefined, "2026-07-12T19:59:45.000Z");
    freshNode.meta.trade = "Welding";
    const next = { ...empty, nodes: [freshNode], counts: { ...empty.counts, nodes: 1, knowledge: 1 } } satisfies GraphModel;
    const delta = computeGraphDelta(empty, next, 1, snapshot);
    expect(delta.addedKnowledgeCount).toBe(1);
    expect(delta.addedByTrade).toEqual([{ trade: "Welding", count: 1 }]);
  });
});
