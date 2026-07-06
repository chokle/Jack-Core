// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { useState } from "react";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import {
  buildGraphModelFromServer,
  type MemoryNode,
  type ServerGraphNode,
} from "../lib/memory-graph";
import { ProvenanceContent } from "./MemoryGraphView";

/**
 * The user-visible half of the withdrawn-evidence "Dismiss" feature. The backend
 * (`restoreWithdrawnEvidence` + the admin-gated route) is covered by lib/route
 * tests; this file guards the *browser* surface that is most likely to silently
 * regress:
 *
 *   1. The "Dismiss" control appears ONLY for an admin viewer (it is gated in
 *      code by the `isAdmin` prop, mirroring the server's `requireAdminSession`).
 *   2. Clicking it targets the concept + the withdrawn source, i.e. it calls the
 *      gated endpoint with the right identifiers (`node.id`, `r.videoId`).
 *   3. It cannot double-fire while a restore is already in flight.
 *   4. Once the graph query refetches with the entry cleared (the app invalidates
 *      the graph query on success), the withdrawn-evidence entry disappears in
 *      place — no page reload — while the rest of the Provenance panel persists.
 *
 * NOTE ON SCOPE: a true Playwright pass that signs in as an admin and clicks the
 * live button is not possible in this environment — the admin session is
 * HMAC-signed with the `JACK_ADMIN_KEY` *secret*, which the Playwright testing
 * subagent cannot be given without leaking it into its transcript (enabling
 * reviewer sign-in for browser tests is a separate task). `ProvenanceContent` is
 * exported precisely so this render surface can be exercised in isolation, the
 * same convention the sibling `MemoryGraphView.provenance.test.tsx` uses.
 */

// A concept carrying withdrawn evidence that resolves to a real source video
// (so the entry renders its label), plus an "Extracted by" block that must
// survive after the withdrawn entry is cleared.
const concept: ServerGraphNode = {
  id: "concept:root-pass",
  kind: "concept",
  label: "Root Pass",
  trade: "Welder",
  confidence: 0.82,
  meta: {
    category: "concept",
    sourceCount: 2,
    sourceVideoIds: ["v-keep"],
    timestamps: [12],
    sources: [
      {
        videoId: "v-keep",
        timestamps: [12],
        confidence: 0.7,
        model: "gpt-4o",
        extractedAt: "2026-01-02T00:00:00.000Z",
      },
    ],
    models: ["gpt-4o"],
    firstExtractedAt: "2026-01-02T00:00:00.000Z",
    lastExtractedAt: "2026-02-10T00:00:00.000Z",
    rejectedEvidence: [
      {
        videoId: "v-dropped",
        at: "2026-03-01T00:00:00.000Z",
        reason: "no longer corroborates",
      },
    ],
  },
};

// A resolvable source video for the withdrawn entry so it renders as a clickable
// label rather than the "Removed source" fallback.
const droppedVideo: ServerGraphNode = {
  id: "video:v-dropped",
  kind: "video",
  label: "Overhead 6G Pass",
  trade: "Welder",
};

function buildNodes(c: ServerGraphNode) {
  const model = buildGraphModelFromServer({
    nodes: [
      { id: "__jack__", kind: "core", label: "JACK" },
      { id: "topic:Welder", kind: "topic", label: "Welder", trade: "Welder" },
      droppedVideo,
      c,
    ],
    edges: [
      { id: "e1", source: "__jack__", target: "topic:Welder", kind: "topic" },
      { id: "e2", source: "topic:Welder", target: c.id, kind: "knowledge" },
      { id: "e3", source: "topic:Welder", target: droppedVideo.id, kind: "video" },
    ],
  });
  const nodeById = new Map<string, MemoryNode>(
    model.nodes.map((n) => [n.id, n]),
  );
  return { nodeById };
}

function renderProvenance(opts: {
  isAdmin: boolean;
  isRestoringEvidence?: boolean;
  onRestoreEvidence?: (id: string, videoId: string) => void;
}) {
  const { nodeById } = buildNodes(concept);
  const node = nodeById.get(concept.id)!;
  return render(
    <ProvenanceContent
      node={node}
      nodeById={nodeById}
      onSelectNode={() => {}}
      onOpenVideo={() => {}}
      isAdmin={opts.isAdmin}
      isRestoringEvidence={opts.isRestoringEvidence ?? false}
      onRestoreEvidence={opts.onRestoreEvidence ?? (() => {})}
    />,
  );
}

afterEach(() => {
  cleanup();
});

describe("Dismiss withdrawn-evidence control — admin gate", () => {
  it("shows the Dismiss control to an admin viewer", () => {
    renderProvenance({ isAdmin: true });
    expect(screen.getByText("Withdrawn evidence")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
  });

  it("hides the Dismiss control from a non-admin viewer", () => {
    renderProvenance({ isAdmin: false });
    // The withdrawn-evidence entry still renders for everyone...
    expect(screen.getByText("Withdrawn evidence")).toBeTruthy();
    expect(screen.getByText("Overhead 6G Pass")).toBeTruthy();
    // ...but the admin-only action is absent.
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });
});

describe("Dismiss withdrawn-evidence control — action", () => {
  it("clicking Dismiss targets the concept and the withdrawn source", () => {
    const onRestoreEvidence = vi.fn();
    renderProvenance({ isAdmin: true, onRestoreEvidence });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    // These are exactly the identifiers the gated POST route consumes
    // (node id + the withdrawn source's videoId).
    expect(onRestoreEvidence).toHaveBeenCalledTimes(1);
    expect(onRestoreEvidence).toHaveBeenCalledWith("concept:root-pass", "v-dropped");
  });

  it("disables Dismiss while a restore is already in flight (no double-fire)", () => {
    const onRestoreEvidence = vi.fn();
    renderProvenance({
      isAdmin: true,
      isRestoringEvidence: true,
      onRestoreEvidence,
    });
    const btn = screen.getByRole("button", { name: "Dismiss" });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(btn);
    expect(onRestoreEvidence).not.toHaveBeenCalled();
  });
});

describe("Dismiss withdrawn-evidence control — refresh without reload", () => {
  it("clears the entry in place once the graph refetches, keeping the panel", () => {
    // Harness that mirrors the real flow: on success the app invalidates the
    // graph query, which refetches a graph whose node no longer carries the
    // rejectedEvidence entry. Here that manifests as a prop change on the SAME
    // mounted component — proving the entry disappears reactively, not via a
    // page reload / remount.
    function Harness() {
      const [cleared, setCleared] = useState(false);
      const source: ServerGraphNode = cleared
        ? { ...concept, meta: { ...concept.meta!, rejectedEvidence: [] } }
        : concept;
      const { nodeById } = buildNodes(source);
      return (
        <ProvenanceContent
          node={nodeById.get(concept.id)!}
          nodeById={nodeById}
          onSelectNode={() => {}}
          onOpenVideo={() => {}}
          isAdmin={true}
          isRestoringEvidence={false}
          onRestoreEvidence={() => setCleared(true)}
        />
      );
    }

    render(<Harness />);

    // Before: the withdrawn-evidence block and the rest of the panel are shown.
    expect(screen.getByText("Withdrawn evidence")).toBeTruthy();
    expect(screen.getByText("Overhead 6G Pass")).toBeTruthy();
    expect(screen.getByText("Extracted by")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    // After the refetch: the withdrawn entry is gone, but the surrounding
    // Provenance panel is still mounted (no reload) — "Extracted by" persists.
    expect(screen.queryByText("Withdrawn evidence")).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    expect(screen.getByText("Extracted by")).toBeTruthy();
  });
});
