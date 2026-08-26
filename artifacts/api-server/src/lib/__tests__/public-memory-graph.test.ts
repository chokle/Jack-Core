import { describe, expect, it } from "vitest";
import type { KnowledgeGraph } from "../memory-graph.js";
import { filterPublicGraph } from "../public-memory-graph.js";

const now = "2026-08-26T08:00:00.000Z";

function graph(): KnowledgeGraph {
  return {
    nodes: [
      {
        id: "__jack__",
        kind: "core",
        label: "JACK",
        trade: null,
        refId: null,
        description: null,
        confidence: null,
        verificationStatus: "unverified",
        meta: {},
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "topic:Welder",
        kind: "topic",
        label: "Welder",
        trade: "Welder",
        refId: null,
        description: null,
        confidence: null,
        verificationStatus: "unverified",
        meta: {},
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "k:concept:trusted",
        kind: "concept",
        label: "Trusted concept",
        trade: "Welder",
        refId: null,
        description: "Keep this visible.",
        confidence: 0.9,
        verificationStatus: "verified",
        meta: {},
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "k:concept:rejected",
        kind: "concept",
        label: "Rejected concept",
        trade: "Welder",
        refId: null,
        description: "Never expose this in Living Memory.",
        confidence: 0.2,
        verificationStatus: "rejected",
        meta: {},
        createdAt: now,
        updatedAt: now,
      },
    ],
    edges: [
      {
        id: "e:core-topic",
        source: "__jack__",
        target: "topic:Welder",
        kind: "topic",
        weight: 1,
        meta: {},
      },
      {
        id: "e:trusted-topic",
        source: "k:concept:trusted",
        target: "topic:Welder",
        kind: "topic",
        weight: 1,
        meta: {},
      },
      {
        id: "e:rejected-topic",
        source: "k:concept:rejected",
        target: "topic:Welder",
        kind: "topic",
        weight: 1,
        meta: {},
      },
    ],
    counts: {
      nodes: 4,
      edges: 3,
      topics: 1,
      competencies: 0,
      videos: 0,
      knowledge: 2,
    },
    generatedAt: now,
  };
}

describe("filterPublicGraph", () => {
  it("removes rejected knowledge and every incident edge while keeping trusted knowledge", () => {
    const result = filterPublicGraph(graph());

    expect(result.nodes.map((node) => node.id)).toEqual([
      "__jack__",
      "topic:Welder",
      "k:concept:trusted",
    ]);
    expect(result.edges.map((edge) => edge.id)).toEqual([
      "e:core-topic",
      "e:trusted-topic",
    ]);
    expect(result.counts).toEqual({
      nodes: 3,
      edges: 2,
      topics: 1,
      competencies: 0,
      videos: 0,
      knowledge: 1,
    });
  });

  it("returns the original snapshot when there is nothing to hide", () => {
    const input = graph();
    input.nodes = input.nodes.filter((node) => node.verificationStatus !== "rejected");
    input.edges = input.edges.filter((edge) => edge.id !== "e:rejected-topic");
    input.counts = { ...input.counts, nodes: 3, edges: 2, knowledge: 1 };

    expect(filterPublicGraph(input)).toBe(input);
  });
});
