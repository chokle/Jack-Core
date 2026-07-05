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

describe("buildGraphModelFromServer — provenance passthrough", () => {
  const provNode: ServerGraphNode = {
    id: "concept:root-pass",
    kind: "concept",
    label: "Root Pass",
    trade: "Welder",
    confidence: 0.82,
    verificationStatus: "verified",
    meta: {
      category: "concept",
      sourceCount: 2,
      sourceVideoIds: ["v1", "v2"],
      timestamps: [12, 40],
      sources: [
        {
          videoId: "v1",
          timestamps: [12],
          confidence: 0.7,
          model: "gpt-4o",
          extractedAt: "2026-01-02T00:00:00.000Z",
        },
        {
          videoId: "v2",
          timestamps: [40],
          confidence: 0.6,
          model: "gpt-4o-mini",
          extractedAt: "2026-02-10T00:00:00.000Z",
        },
      ],
      models: ["gpt-4o", "gpt-4o-mini"],
      firstExtractedAt: "2026-01-02T00:00:00.000Z",
      lastExtractedAt: "2026-02-10T00:00:00.000Z",
      confidenceHistory: [
        { confidence: 0.7, sourceCount: 1, at: "2026-01-02T00:00:00.000Z" },
        { confidence: 0.82, sourceCount: 2, at: "2026-02-10T00:00:00.000Z" },
      ],
      mergedFrom: [
        {
          id: "concept:root-bead",
          label: "Root Bead",
          category: "concept",
          at: "2026-02-10T00:00:00.000Z",
        },
      ],
      rejectedEvidence: [
        { videoId: "v9", at: "2026-03-01T00:00:00.000Z", reason: "off-topic" },
      ],
      verificationHistory: [
        { from: "unverified", to: "verified", at: "2026-02-11T00:00:00.000Z" },
      ],
    },
  };

  const model = buildGraphModelFromServer({
    nodes: [
      { id: "__jack__", kind: "core", label: "JACK" },
      { id: "topic:Welder", kind: "topic", label: "Welder", trade: "Welder" },
      provNode,
    ],
    edges: [
      { id: "e1", source: "__jack__", target: "topic:Welder", kind: "topic" },
      {
        id: "e2",
        source: "topic:Welder",
        target: "concept:root-pass",
        kind: "knowledge",
      },
    ],
  });
  const concept = model.nodes.find((n) => n.id === "concept:root-pass")!;

  it("maps the extraction provenance (models + first/last dates)", () => {
    expect(concept.meta.models).toEqual(["gpt-4o", "gpt-4o-mini"]);
    expect(concept.meta.firstExtractedAt).toBe("2026-01-02T00:00:00.000Z");
    expect(concept.meta.lastExtractedAt).toBe("2026-02-10T00:00:00.000Z");
  });

  it("carries per-source model + extractedAt through", () => {
    expect(concept.meta.sources?.[0]).toMatchObject({
      videoId: "v1",
      model: "gpt-4o",
      extractedAt: "2026-01-02T00:00:00.000Z",
    });
  });

  it("maps the confidence-over-time history", () => {
    expect(concept.meta.confidenceHistory).toHaveLength(2);
    expect(concept.meta.confidenceHistory?.[1]).toEqual({
      confidence: 0.82,
      sourceCount: 2,
      at: "2026-02-10T00:00:00.000Z",
    });
  });

  it("maps merged-in concepts and withdrawn evidence", () => {
    expect(concept.meta.mergedFrom?.[0]).toMatchObject({
      id: "concept:root-bead",
      label: "Root Bead",
    });
    expect(concept.meta.rejectedEvidence?.[0]).toMatchObject({
      videoId: "v9",
      reason: "off-topic",
    });
  });

  it("maps the human verification history", () => {
    expect(concept.meta.verificationHistory?.[0]).toEqual({
      from: "unverified",
      to: "verified",
      at: "2026-02-11T00:00:00.000Z",
    });
  });

  it("defaults the ledger to empty arrays when the server omits it", () => {
    const bare = buildGraphModelFromServer({
      nodes: [
        { id: "__jack__", kind: "core", label: "JACK" },
        { id: "topic:Welder", kind: "topic", label: "Welder", trade: "Welder" },
        { id: "concept:x", kind: "concept", label: "X", trade: "Welder" },
      ],
      edges: [],
    });
    const c = bare.nodes.find((n) => n.id === "concept:x")!;
    expect(c.meta.models).toEqual([]);
    expect(c.meta.confidenceHistory).toEqual([]);
    expect(c.meta.mergedFrom).toEqual([]);
    expect(c.meta.rejectedEvidence).toEqual([]);
    expect(c.meta.verificationHistory).toEqual([]);
    expect(c.meta.firstExtractedAt).toBeUndefined();
  });
});
