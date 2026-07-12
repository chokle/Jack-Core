import { describe, expect, it } from "vitest";
import { isRecentGrowthNode, type MemoryNode } from "./memory-graph";

function node(createdAt?: string): MemoryNode {
  return {
    id: "k:procedure:test",
    kind: "procedure",
    label: "Test",
    color: [255, 100, 0],
    meta: { createdAt },
  } as MemoryNode;
}

describe("growth toast freshness", () => {
  const snapshot = "2026-07-12T20:00:00.000Z";

  it("accepts knowledge created in the current ingestion window", () => {
    expect(isRecentGrowthNode(node("2026-07-12T19:59:45.000Z"), snapshot)).toBe(true);
  });

  it("rejects week-old and undated placeholder knowledge", () => {
    expect(isRecentGrowthNode(node("2026-07-05T20:00:00.000Z"), snapshot)).toBe(false);
    expect(isRecentGrowthNode(node(), snapshot)).toBe(false);
  });
});
