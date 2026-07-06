import { describe, it, expect } from "vitest";
import {
  buildGraphModelFromServer,
  isKnowledgeKind,
  type ServerGraphNode,
  type ServerGraphEdge,
} from "./memory-graph";

/**
 * Guards the video-sourced-knowledge contract on the CLIENT side of GET /graph:
 * the `readSources()` mapper must preserve each source's `videoId` + `timestamps`
 * off the persisted node, and those timestamps must fall within the source
 * video's transcript segments — the exact overlap `TranscriptContent` /
 * "Source Videos" jump buttons in MemoryGraphView use.
 *
 * A silent drop/rename of the `videoId` or `timestamps` source field (in the
 * server payload OR the mapper) would leave concepts unjumpable with no error;
 * these tests fail instead of returning empty timestamps.
 */

const VIDEO_ID = "vid-root-pass";

/** Transcript segments exactly as GET /videos/:id returns them (camelCase). */
const segments = [
  { id: "s0", startTime: 0, endTime: 8, text: "strike the arc" },
  { id: "s1", startTime: 8, endTime: 17, text: "lay the root pass" },
  { id: "s2", startTime: 17, endTime: 26, text: "inspect the bead" },
];

/** A GET /graph payload with a completed video + a distilled concept whose
 *  provenance cites moments inside the video's transcript segments. */
const serverNodes: ServerGraphNode[] = [
  { id: "__jack__", kind: "core", label: "JACK" },
  { id: "topic:Welder", kind: "topic", label: "Welder", trade: "Welder" },
  {
    id: `video:${VIDEO_ID}`,
    kind: "video",
    label: "Root Pass Fundamentals",
    trade: "Welder",
    meta: { status: "completed" },
  },
  {
    id: "k:concept:root-pass",
    kind: "concept",
    label: "Root Pass",
    trade: "Welder",
    confidence: 0.7,
    verificationStatus: "unverified",
    meta: {
      category: "concept",
      timestamps: [3, 12],
      sourceCount: 1,
      sourceVideoIds: [VIDEO_ID],
      sources: [{ videoId: VIDEO_ID, timestamps: [3, 12], confidence: 0.7 }],
    },
  },
];

const serverEdges: ServerGraphEdge[] = [
  { id: "e1", source: "__jack__", target: "topic:Welder", kind: "topic" },
  { id: "e2", source: "topic:Welder", target: `video:${VIDEO_ID}`, kind: "video" },
  { id: "e3", source: "topic:Welder", target: "k:concept:root-pass", kind: "knowledge" },
];

function withinAnySegment(t: number): boolean {
  return segments.some((s) => t >= s.startTime && t <= s.endTime);
}

describe("readSources() ↔ transcript-segment overlap (client mapper)", () => {
  it("preserves per-source videoId + timestamps that fall within the video's segments", () => {
    const model = buildGraphModelFromServer({ nodes: serverNodes, edges: serverEdges });

    const knowledge = model.nodes.filter((n) => isKnowledgeKind(n.kind));
    expect(knowledge.length).toBeGreaterThan(0);

    // At least one knowledge node keeps a source for THIS video whose timestamps
    // all land inside a transcript segment [startTime, endTime].
    const matching = knowledge.filter((n) =>
      (n.meta.sources ?? []).some(
        (s) =>
          s.videoId === VIDEO_ID &&
          s.timestamps.length > 0 &&
          s.timestamps.every(withinAnySegment),
      ),
    );
    expect(matching.length).toBeGreaterThan(0);

    // The concrete field values survive the mapper — a renamed/dropped source
    // field would leave these empty and this assertion would fail.
    const node = matching[0]!;
    const src = (node.meta.sources ?? []).find((s) => s.videoId === VIDEO_ID)!;
    expect(src.videoId).toBe(VIDEO_ID);
    expect(src.timestamps).toEqual([3, 12]);
  });

  it("drops a source whose videoId field is renamed rather than inventing one", () => {
    // Simulate a schema drift: the source object uses `video_id` (snake_case)
    // instead of the contract's `videoId`. The mapper must NOT silently keep an
    // empty-videoId source — it drops it, so the concept reads as unsourced and
    // the overlap assertion above would fail on real data (catching the drift).
    const drifted: ServerGraphNode[] = serverNodes.map((n) =>
      n.id === "k:concept:root-pass"
        ? {
            ...n,
            meta: {
              ...(n.meta ?? {}),
              sources: [{ video_id: VIDEO_ID, timestamps: [3, 12], confidence: 0.7 }],
            },
          }
        : n,
    );

    const model = buildGraphModelFromServer({ nodes: drifted, edges: serverEdges });
    const node = model.nodes.find((n) => n.id === "k:concept:root-pass")!;
    expect(node.meta.sources).toEqual([]);
  });

  it("keeps a source but empties timestamps when the timestamps field is renamed", () => {
    const drifted: ServerGraphNode[] = serverNodes.map((n) =>
      n.id === "k:concept:root-pass"
        ? {
            ...n,
            meta: {
              ...(n.meta ?? {}),
              sources: [{ videoId: VIDEO_ID, stamps: [3, 12], confidence: 0.7 }],
            },
          }
        : n,
    );

    const model = buildGraphModelFromServer({ nodes: drifted, edges: serverEdges });
    const node = model.nodes.find((n) => n.id === "k:concept:root-pass")!;
    const src = (node.meta.sources ?? []).find((s) => s.videoId === VIDEO_ID);
    expect(src).toBeDefined();
    // A dropped/renamed `timestamps` field leaves NO cited moments — the concept
    // becomes unjumpable. The overlap test above would fail on real data.
    expect(src!.timestamps).toEqual([]);
  });
});
