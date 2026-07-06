// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import {
  buildGraphModelFromServer,
  isKnowledgeKind,
  type MemoryNode,
  type ServerGraphNode,
  type ServerGraphEdge,
  type RawCompetency,
} from "../lib/memory-graph";
import type {
  VideoDetail,
  TranscriptSegment,
  VerificationUpdateStatus,
} from "@workspace/api-client-react";
import { NodeDetailBody } from "./MemoryGraphView";

/**
 * Rendering coverage for the node inspector's collapsible sections — everything
 * the Provenance panel test (`MemoryGraphView.provenance.test.tsx`) doesn't
 * already guard: the "Captured Content" a source video yields (its analysis +
 * key points, and the verbatim transcript passages a concept cites), the
 * Captured Knowledge confidence bar + aliases, the Source Videos list with its
 * timestamp-jump buttons, Competencies, Related Nodes, and the admin-only Review
 * verify/reject controls.
 *
 * These sections silently stop rendering if the API contract or the
 * conditional-render gates in `NodeDetailBody` drift, so the tests bind to the
 * exact camelCase contract the UI reads (`analysis`, `keyPoints`, and
 * `segments[]{ startTime, endTime, text }` off the fetched video; `confidence`,
 * `aliases`, and `sources` off the mapped node). Nodes are built via
 * `buildGraphModelFromServer` — the same mapper the app uses — so the fixtures
 * can't drift from the real `MemoryNode` shape.
 *
 * The Captured Content sections fetch their source video via `useGetVideo`;
 * that hook is the one piece we control here (returning a `VideoDetail` fixture)
 * so a stale field name or removed section fails a test instead of shipping.
 */

const videoState = vi.hoisted(() => ({
  data: undefined as VideoDetail | undefined,
  isLoading: false,
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    // Only the video fetch is stubbed; the real query-key helpers and every
    // other export stay intact, so nothing else in the module changes behavior.
    useGetVideo: () => ({ data: videoState.data, isLoading: videoState.isLoading }),
  };
});

function makeVideoDetail(overrides: Partial<VideoDetail> = {}): VideoDetail {
  return {
    id: "v1",
    title: "Root Pass Demo",
    status: "completed",
    createdAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

// Build the graph the same way the app does, plus the derived indexes the
// inspector feeds to `NodeDetailBody` (adjacency + knowledge-by-video), so each
// section receives realistic, mapped data rather than hand-rolled fixtures.
function buildGraph(nodes: ServerGraphNode[], edges: ServerGraphEdge[]) {
  const model = buildGraphModelFromServer({
    nodes: [
      { id: "__jack__", kind: "core", label: "JACK" },
      { id: "topic:Welder", kind: "topic", label: "Welder", trade: "Welder" },
      ...nodes,
    ],
    edges: [
      { id: "e-core", source: "__jack__", target: "topic:Welder", kind: "topic" },
      ...edges,
    ],
  });
  const nodeById = new Map<string, MemoryNode>(
    model.nodes.map((n) => [n.id, n]),
  );
  const adjacency = new Map<string, Set<string>>();
  for (const e of model.edges) {
    if (!adjacency.has(e.a)) adjacency.set(e.a, new Set());
    if (!adjacency.has(e.b)) adjacency.set(e.b, new Set());
    adjacency.get(e.a)!.add(e.b);
    adjacency.get(e.b)!.add(e.a);
  }
  const knowledgeByVideoId = new Map<string, MemoryNode[]>();
  for (const n of model.nodes) {
    if (!isKnowledgeKind(n.kind)) continue;
    for (const s of n.meta.sources ?? []) {
      if (!knowledgeByVideoId.has(s.videoId))
        knowledgeByVideoId.set(s.videoId, []);
      knowledgeByVideoId.get(s.videoId)!.push(n);
    }
  }
  return { model, nodeById, adjacency, knowledgeByVideoId };
}

interface BodyCtx {
  nodeById: Map<string, MemoryNode>;
  adjacency?: Map<string, Set<string>>;
  knowledgeByVideoId?: Map<string, MemoryNode[]>;
  competencies?: RawCompetency[];
  isAdmin?: boolean;
  onJumpToTimestamp?: (videoId: string, startTime: number) => void;
  onSetVerification?: (id: string, status: VerificationUpdateStatus) => void;
}

// NodeDetailBody has a large prop surface; only the fields under test matter,
// the rest are inert stubs (mirrors `renderDetailBody` in the provenance test).
function renderBody(node: MemoryNode, ctx: BodyCtx) {
  const competencies = ctx.competencies ?? [];
  const compByCode = new Map(competencies.map((c) => [c.code, c.name]));
  return render(
    <NodeDetailBody
      node={node}
      degree={1}
      videoCount={0}
      relatedVideoCount={0}
      nodeById={ctx.nodeById}
      adjacency={ctx.adjacency ?? new Map()}
      knowledgeByVideoId={ctx.knowledgeByVideoId ?? new Map()}
      compByCode={compByCode}
      competencies={competencies}
      onOpenVideo={() => {}}
      onJumpToTimestamp={ctx.onJumpToTimestamp ?? (() => {})}
      onSelectNode={() => {}}
      onResumeInterview={() => {}}
      onResumeChat={() => {}}
      onStartInterview={() => {}}
      isAdmin={ctx.isAdmin ?? false}
      isUpdatingVerification={false}
      onSetVerification={ctx.onSetVerification ?? (() => {})}
      isRestoringEvidence={false}
      onRestoreEvidence={() => {}}
    />,
  );
}

const CONCEPT_ROOT_PASS: ServerGraphNode = {
  id: "concept:root-pass",
  kind: "concept",
  label: "Root Pass",
  trade: "Welder",
  meta: { sources: [{ videoId: "v1", timestamps: [10], confidence: 0.8 }] },
};

beforeEach(() => {
  videoState.data = undefined;
  videoState.isLoading = false;
});

afterEach(() => {
  cleanup();
});

describe("Captured Content — video source (analysis + key points)", () => {
  it("renders the summary and every key point from the video's analysis/keyPoints", () => {
    videoState.data = makeVideoDetail({
      analysis: "Jack's summary of the root pass technique.",
      keyPoints: ["Keep a tight arc length", "Maintain a steady travel speed"],
    });
    const { nodeById } = buildGraph(
      [{ id: "video:v1", kind: "video", label: "Root Pass Demo", trade: "Welder" }],
      [{ id: "e1", source: "topic:Welder", target: "video:v1", kind: "topic" }],
    );

    renderBody(nodeById.get("video:v1")!, { nodeById });
    fireEvent.click(screen.getByRole("button", { name: /Captured Knowledge/i }));

    expect(
      screen.getByText("Jack's summary of the root pass technique."),
    ).toBeTruthy();
    expect(screen.getByText("Key Points")).toBeTruthy();
    expect(screen.getByText("Keep a tight arc length")).toBeTruthy();
    expect(screen.getByText("Maintain a steady travel speed")).toBeTruthy();
  });

  it("falls back to a 'still processing' note when the video has no analysis yet", () => {
    videoState.data = makeVideoDetail({ analysis: null, keyPoints: [] });
    const { nodeById } = buildGraph(
      [{ id: "video:v1", kind: "video", label: "Root Pass Demo", trade: "Welder" }],
      [{ id: "e1", source: "topic:Welder", target: "video:v1", kind: "topic" }],
    );

    renderBody(nodeById.get("video:v1")!, { nodeById });
    fireEvent.click(screen.getByRole("button", { name: /Captured Knowledge/i }));

    expect(screen.getByText(/still processing/i)).toBeTruthy();
  });
});

describe("Captured Content — transcript passages", () => {
  it("renders each captured segment of a video with a wired timestamp-jump button", () => {
    videoState.data = makeVideoDetail({
      segments: [
        {
          id: "s1",
          startTime: 12,
          endTime: 15,
          text: "Strike the arc and establish your puddle.",
        },
        {
          id: "s2",
          startTime: 45,
          endTime: 49,
          text: "Keep the rod angled about fifteen degrees.",
        },
      ] satisfies TranscriptSegment[],
    });
    const onJumpToTimestamp = vi.fn();
    const { nodeById } = buildGraph(
      [{ id: "video:v1", kind: "video", label: "Root Pass Demo", trade: "Welder" }],
      [{ id: "e1", source: "topic:Welder", target: "video:v1", kind: "topic" }],
    );

    renderBody(nodeById.get("video:v1")!, { nodeById, onJumpToTimestamp });
    fireEvent.click(screen.getByRole("button", { name: /Transcript/i }));

    expect(
      screen.getByText("Strike the arc and establish your puddle."),
    ).toBeTruthy();
    expect(
      screen.getByText("Keep the rod angled about fifteen degrees."),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /0:12/ }));
    expect(onJumpToTimestamp).toHaveBeenCalledWith("v1", 12);
  });

  it("renders a concept's verbatim cited passage at the cited timestamp", () => {
    videoState.data = makeVideoDetail({
      title: "Welding Fundamentals",
      segments: [
        {
          id: "s1",
          startTime: 10,
          endTime: 14,
          text: "The root pass fuses the two base metals.",
        },
        {
          id: "s2",
          startTime: 30,
          endTime: 34,
          text: "Grind between passes to remove slag.",
        },
      ] satisfies TranscriptSegment[],
    });
    const onJumpToTimestamp = vi.fn();
    const { nodeById } = buildGraph(
      [
        { id: "video:v1", kind: "video", label: "Welding Fundamentals", trade: "Welder" },
        CONCEPT_ROOT_PASS,
      ],
      [
        { id: "e1", source: "topic:Welder", target: "video:v1", kind: "topic" },
        { id: "e2", source: "topic:Welder", target: "concept:root-pass", kind: "knowledge" },
      ],
    );

    renderBody(nodeById.get("concept:root-pass")!, { nodeById, onJumpToTimestamp });
    fireEvent.click(screen.getByRole("button", { name: /Transcript/i }));

    expect(screen.getByText("Cited in Welding Fundamentals")).toBeTruthy();
    // The passage picked for the cited moment (10s), not the unrelated one (30s).
    expect(
      screen.getByText(/The root pass fuses the two base metals\./),
    ).toBeTruthy();
    expect(
      screen.queryByText(/Grind between passes to remove slag\./),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /0:10/ }));
    expect(onJumpToTimestamp).toHaveBeenCalledWith("v1", 10);
  });
});

describe("Captured Knowledge — concept confidence + aliases", () => {
  it("renders the confidence bar and the alias chips", () => {
    const { nodeById } = buildGraph(
      [
        {
          id: "concept:root-pass",
          kind: "concept",
          label: "Root Pass",
          trade: "Welder",
          confidence: 0.8,
          meta: {
            aliases: ["Stringer bead", "Fill pass"],
            sources: [{ videoId: "v1", timestamps: [10], confidence: 0.8 }],
          },
        },
      ],
      [{ id: "e2", source: "topic:Welder", target: "concept:root-pass", kind: "knowledge" }],
    );

    renderBody(nodeById.get("concept:root-pass")!, { nodeById });
    fireEvent.click(screen.getByRole("button", { name: /Captured Knowledge/i }));

    expect(screen.getByText("Confidence")).toBeTruthy();
    expect(screen.getByText("80%")).toBeTruthy();
    expect(screen.getByText("Also called")).toBeTruthy();
    expect(screen.getByText("Stringer bead")).toBeTruthy();
    expect(screen.getByText("Fill pass")).toBeTruthy();
  });
});

describe("Source Videos — timestamp-jump buttons", () => {
  it("lists the source video and wires each timestamp button to that moment", () => {
    const onJumpToTimestamp = vi.fn();
    const { nodeById } = buildGraph(
      [
        { id: "video:v1", kind: "video", label: "Welding Basics", trade: "Welder" },
        {
          id: "concept:root-pass",
          kind: "concept",
          label: "Root Pass",
          trade: "Welder",
          meta: { sources: [{ videoId: "v1", timestamps: [12, 45], confidence: 0.8 }] },
        },
      ],
      [
        { id: "e1", source: "topic:Welder", target: "video:v1", kind: "topic" },
        { id: "e2", source: "topic:Welder", target: "concept:root-pass", kind: "knowledge" },
      ],
    );

    renderBody(nodeById.get("concept:root-pass")!, { nodeById, onJumpToTimestamp });
    fireEvent.click(screen.getByRole("button", { name: /Source Videos/i }));

    expect(screen.getByText("Welding Basics")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /0:45/ }));
    expect(onJumpToTimestamp).toHaveBeenCalledWith("v1", 45);
  });
});

describe("Competencies", () => {
  it("lists the competencies linked to a concept (code + name)", () => {
    const { nodeById, adjacency } = buildGraph(
      [
        CONCEPT_ROOT_PASS,
        {
          id: "comp:A1",
          kind: "competency",
          label: "Perform SMAW welds",
          trade: "Welder",
          meta: { code: "A1" },
        },
      ],
      [
        { id: "e2", source: "topic:Welder", target: "concept:root-pass", kind: "knowledge" },
        { id: "e3", source: "concept:root-pass", target: "comp:A1", kind: "competency" },
      ],
    );

    renderBody(nodeById.get("concept:root-pass")!, {
      nodeById,
      adjacency,
      competencies: [{ code: "A1", name: "Perform SMAW welds", trade: "Welder" }],
    });
    fireEvent.click(screen.getByRole("button", { name: /Competencies/i }));

    expect(screen.getByText("A1 · Perform SMAW welds")).toBeTruthy();
  });
});

describe("Related Nodes", () => {
  it("surfaces concepts co-taught in the same source video", () => {
    const { nodeById, knowledgeByVideoId } = buildGraph(
      [
        CONCEPT_ROOT_PASS,
        {
          id: "concept:tack-weld",
          kind: "concept",
          label: "Tack Weld",
          trade: "Welder",
          meta: { sources: [{ videoId: "v1", timestamps: [30], confidence: 0.7 }] },
        },
      ],
      [
        { id: "e2", source: "topic:Welder", target: "concept:root-pass", kind: "knowledge" },
        { id: "e3", source: "topic:Welder", target: "concept:tack-weld", kind: "knowledge" },
      ],
    );

    renderBody(nodeById.get("concept:root-pass")!, { nodeById, knowledgeByVideoId });
    fireEvent.click(screen.getByRole("button", { name: /Related Nodes/i }));

    expect(screen.getByText("Tack Weld")).toBeTruthy();
  });
});

describe("admin Review controls", () => {
  it("renders Verify/Reject/Reset for an admin session and wires the action", () => {
    const onSetVerification = vi.fn();
    const { nodeById } = buildGraph(
      [CONCEPT_ROOT_PASS],
      [{ id: "e2", source: "topic:Welder", target: "concept:root-pass", kind: "knowledge" }],
    );

    renderBody(nodeById.get("concept:root-pass")!, {
      nodeById,
      isAdmin: true,
      onSetVerification,
    });

    expect(screen.getByText("Review")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Reject/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Reset/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Verify/i }));
    expect(onSetVerification).toHaveBeenCalledWith("concept:root-pass", "verified");
  });

  it("hides the Review controls entirely without an admin session", () => {
    const { nodeById } = buildGraph(
      [CONCEPT_ROOT_PASS],
      [{ id: "e2", source: "topic:Welder", target: "concept:root-pass", kind: "knowledge" }],
    );

    renderBody(nodeById.get("concept:root-pass")!, { nodeById, isAdmin: false });

    expect(screen.queryByText("Review")).toBeNull();
    expect(screen.queryByRole("button", { name: /Verify/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Reject/i })).toBeNull();
  });
});
