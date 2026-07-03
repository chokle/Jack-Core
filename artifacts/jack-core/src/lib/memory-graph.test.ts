import { describe, it, expect } from "vitest";
import {
  selectMemoryGraphModel,
  buildGraphModel,
  buildGraphModelFromServer,
  type RawVideo,
  type RawCompetency,
  type ServerGraphNode,
  type ServerGraphEdge,
  type MaybeServerGraph,
} from "./memory-graph";

const videos: RawVideo[] = [
  {
    id: "v1",
    title: "Stick Welding Basics",
    trade: "Welder",
    status: "completed",
    competency_codes: ["W-1"],
  },
];

const competencies: RawCompetency[] = [
  { code: "W-1", name: "Weld safely", trade: "Welder", description: "Safety" },
];

const serverNodes: ServerGraphNode[] = [
  { id: "__jack__", kind: "core", label: "JACK" },
  { id: "topic:Welder", kind: "topic", label: "Welder", trade: "Welder" },
  {
    id: "concept:root-pass",
    kind: "concept",
    label: "Root Pass",
    trade: "Welder",
  },
];

const serverEdges: ServerGraphEdge[] = [
  { id: "e1", source: "__jack__", target: "topic:Welder", kind: "topic" },
  {
    id: "e2",
    source: "topic:Welder",
    target: "concept:root-pass",
    kind: "knowledge",
  },
];

describe("selectMemoryGraphModel", () => {
  it("falls back to the client-derived graph when the payload is undefined", () => {
    let model!: ReturnType<typeof selectMemoryGraphModel>;
    expect(() => {
      model = selectMemoryGraphModel(undefined, videos, competencies);
    }).not.toThrow();
    expect(model).toEqual(buildGraphModel(videos, competencies));
    expect(model.nodes.some((n) => n.id === "video:v1")).toBe(true);
  });

  it("falls back to the client-derived graph for an empty object (no nodes)", () => {
    let model!: ReturnType<typeof selectMemoryGraphModel>;
    expect(() => {
      model = selectMemoryGraphModel({} as MaybeServerGraph, videos, competencies);
    }).not.toThrow();
    expect(model).toEqual(buildGraphModel(videos, competencies));
  });

  it("falls back to the client-derived graph for an empty nodes array", () => {
    const model = selectMemoryGraphModel({ nodes: [] }, videos, competencies);
    expect(model).toEqual(buildGraphModel(videos, competencies));
  });

  it("falls back to the client-derived graph when nodes exist but edges are missing", () => {
    let model!: ReturnType<typeof selectMemoryGraphModel>;
    expect(() => {
      model = selectMemoryGraphModel({ nodes: serverNodes }, videos, competencies);
    }).not.toThrow();
    // A payload missing its edges array is malformed → client fallback, not server.
    expect(model).toEqual(buildGraphModel(videos, competencies));
    expect(model.nodes.some((n) => n.id === "video:v1")).toBe(true);
    expect(model.nodes.some((n) => n.id === "concept:root-pass")).toBe(false);
  });

  it("uses the server graph for a well-formed payload", () => {
    const model = selectMemoryGraphModel(
      { nodes: serverNodes, edges: serverEdges },
      videos,
      competencies,
    );
    expect(model).toEqual(
      buildGraphModelFromServer({ nodes: serverNodes, edges: serverEdges }),
    );
    // Server-derived, not the client fallback.
    expect(model.nodes.some((n) => n.id === "video:v1")).toBe(false);
    expect(model.nodes.some((n) => n.id === "concept:root-pass")).toBe(true);
    expect(model.edges.length).toBe(serverEdges.length);
  });
});
