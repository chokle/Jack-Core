// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import {
  buildGraphModelFromServer,
  type MemoryNode,
  type ServerGraphNode,
} from "../lib/memory-graph";
import { ProvenanceContent, NodeDetailBody } from "./MemoryGraphView";

/**
 * Rendering coverage for the concept-inspector's Provenance panel. The
 * data-layer passthrough is already covered in `memory-graph.test.ts`; this file
 * guards the *rendering* in `MemoryGraphView.tsx` — the several conditional
 * branches in `ProvenanceContent`/`ConfidenceSparkline` and the gate in
 * `NodeDetailBody` that decides whether a Provenance section appears at all. A
 * regression that blanks the panel for a concept with rich history, or that
 * shows an empty box for one without, would otherwise slip through.
 *
 * Nodes are built via `buildGraphModelFromServer` (same helper the app uses) so
 * the test binds to real, mapped `MemoryNode` shapes rather than hand-rolled
 * fixtures that could drift from the mapper.
 */

// A concept carrying every provenance block: models + first/last extraction,
// a >=2-point confidence history (so the sparkline renders), a merged-in
// concept, withdrawn evidence, and a human review-history entry.
const richConcept: ServerGraphNode = {
  id: "concept:root-pass",
  kind: "concept",
  label: "Root Pass",
  trade: "Welder",
  confidence: 0.82,
  verificationStatus: "verified",
  meta: {
    category: "concept",
    sourceCount: 2,
    sourceVideoIds: ["v1"],
    timestamps: [12],
    sources: [
      {
        videoId: "v1",
        timestamps: [12],
        confidence: 0.7,
        model: "gpt-4o",
        extractedAt: "2026-01-02T00:00:00.000Z",
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
      {
        from: "unverified",
        to: "verified",
        at: "2026-02-11T00:00:00.000Z",
        reviewer: "Dana the Welder",
      },
    ],
  },
};

// A concept with no ledger at all — every provenance array is empty/undefined.
const bareConcept: ServerGraphNode = {
  id: "concept:tack-weld",
  kind: "concept",
  label: "Tack Weld",
  trade: "Welder",
};

function buildNodes(concept: ServerGraphNode) {
  const model = buildGraphModelFromServer({
    nodes: [
      { id: "__jack__", kind: "core", label: "JACK" },
      { id: "topic:Welder", kind: "topic", label: "Welder", trade: "Welder" },
      concept,
    ],
    edges: [
      { id: "e1", source: "__jack__", target: "topic:Welder", kind: "topic" },
      {
        id: "e2",
        source: "topic:Welder",
        target: concept.id,
        kind: "knowledge",
      },
    ],
  });
  const nodeById = new Map<string, MemoryNode>(
    model.nodes.map((n) => [n.id, n]),
  );
  return { model, nodeById };
}

function renderProvenance(concept: ServerGraphNode) {
  const { nodeById } = buildNodes(concept);
  const node = nodeById.get(concept.id)!;
  return render(
    <ProvenanceContent
      node={node}
      nodeById={nodeById}
      onSelectNode={() => {}}
      onOpenVideo={() => {}}
      isAdmin={false}
      isRestoringEvidence={false}
      onRestoreEvidence={() => {}}
    />,
  );
}

// NodeDetailBody needs a large prop surface; only `node`, `nodeById`, and the
// booleans matter for the Provenance gate. Everything else is stubbed.
function renderDetailBody(node: MemoryNode, nodeById: Map<string, MemoryNode>) {
  return render(
    <NodeDetailBody
      node={node}
      degree={1}
      videoCount={0}
      relatedVideoCount={0}
      nodeById={nodeById}
      adjacency={new Map()}
      knowledgeByVideoId={new Map()}
      compByCode={new Map()}
      competencies={[]}
      onOpenVideo={() => {}}
      onJumpToTimestamp={() => {}}
      onSelectNode={() => {}}
      onResumeInterview={() => {}}
      onResumeChat={() => {}}
      onStartInterview={() => {}}
      isAdmin={false}
      isUpdatingVerification={false}
      onSetVerification={() => {}}
      isRestoringEvidence={false}
      onRestoreEvidence={() => {}}
    />,
  );
}

afterEach(() => {
  cleanup();
});

describe("ProvenanceContent — fully-populated concept", () => {
  it("renders the extracting models", () => {
    renderProvenance(richConcept);
    expect(screen.getByText("gpt-4o")).toBeTruthy();
    expect(screen.getByText("gpt-4o-mini")).toBeTruthy();
  });

  it("renders the first + latest extraction dates", () => {
    renderProvenance(richConcept);
    // "First:" always shows; "Latest:" shows because last !== first.
    expect(screen.getByText("First:")).toBeTruthy();
    expect(screen.getByText("Latest:")).toBeTruthy();
  });

  it("renders the confidence sparkline once there are >=2 points", () => {
    renderProvenance(richConcept);
    const spark = screen.getByRole("img", { name: /confidence moved from/i });
    expect(spark).toBeTruthy();
    // 70% -> 82% over 2 updates.
    expect(spark.getAttribute("aria-label")).toContain("70% to 82%");
    expect(spark.getAttribute("aria-label")).toContain("over 2 updates");
  });

  it("renders the merged-in concepts", () => {
    renderProvenance(richConcept);
    expect(screen.getByText("Merged in 1 concept")).toBeTruthy();
    expect(screen.getByText("Root Bead")).toBeTruthy();
  });

  it("renders withdrawn evidence with its reason", () => {
    renderProvenance(richConcept);
    expect(screen.getByText("Withdrawn evidence")).toBeTruthy();
    // v9 has no resolvable video node → degrades to the "Removed source" label.
    expect(screen.getByText("Removed source")).toBeTruthy();
    expect(screen.getByText(/off-topic/)).toBeTruthy();
  });

  it("renders the human review history", () => {
    renderProvenance(richConcept);
    expect(screen.getByText("Review history")).toBeTruthy();
    expect(screen.getByText(/by Dana the Welder/)).toBeTruthy();
  });
});

describe("ConfidenceSparkline — threshold", () => {
  it("omits the sparkline when there is fewer than 2 confidence points", () => {
    const onetPoint: ServerGraphNode = {
      ...richConcept,
      id: "concept:single-point",
      meta: {
        ...richConcept.meta,
        confidenceHistory: [
          { confidence: 0.7, sourceCount: 1, at: "2026-01-02T00:00:00.000Z" },
        ],
      },
    };
    renderProvenance(onetPoint);
    // Other blocks still render, but the sparkline (an <svg role=img>) is gone.
    expect(screen.getByText("gpt-4o")).toBeTruthy();
    expect(screen.queryByRole("img", { name: /confidence moved from/i })).toBeNull();
  });
});

describe("NodeDetailBody — Provenance section gate", () => {
  it("offers a Provenance section for a concept with a ledger", () => {
    const { nodeById } = buildNodes(richConcept);
    renderDetailBody(nodeById.get(richConcept.id)!, nodeById);
    expect(screen.getByText("Provenance")).toBeTruthy();
  });

  it("hides the Provenance section for a concept with an empty ledger", () => {
    const { nodeById } = buildNodes(bareConcept);
    renderDetailBody(nodeById.get(bareConcept.id)!, nodeById);
    expect(screen.queryByText("Provenance")).toBeNull();
  });

  it("hides the Provenance section for a non-knowledge (topic) node", () => {
    const { nodeById } = buildNodes(richConcept);
    renderDetailBody(nodeById.get("topic:Welder")!, nodeById);
    expect(screen.queryByText("Provenance")).toBeNull();
  });
});
