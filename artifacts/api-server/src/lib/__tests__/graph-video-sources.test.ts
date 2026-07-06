/**
 * Regression guard for the video-sourced-knowledge contract that the Living
 * Memory graph inspector's "Source Videos" jump buttons depend on end-to-end.
 *
 * Task #20 confirmed BY HAND that once a real video processes to `completed`,
 * GET /graph serves distilled knowledge nodes whose `meta.sources[].timestamps`
 * fall inside that video's transcript segment [start_time, end_time] ranges —
 * the exact overlap `TranscriptContent` (jack-core) uses to pull the verbatim
 * passage at each cited moment. Nothing guarded that contract, so a regression
 * in distillation (dropping timestamps) or the persisted-graph mirror (dropping
 * the per-source provenance) would silently strand every video-sourced concept
 * and no test would fail.
 *
 * This exercises the REAL graph builder (syncVideoGraph + syncVideoKnowledge +
 * getGraph) against the in-memory fake Supabase — no live network / AI — and
 * asserts the persisted graph a browser would fetch actually satisfies the
 * timestamps-within-segments overlap.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AtomicKnowledge, KnowledgeCategory } from "../distillation.js";

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
  getGraph,
  knowledgeNodeId,
  KNOWLEDGE_NODE_KINDS,
} from "../memory-graph.js";

const TRADE = "Welder";
const VIDEO_ID = "vid-root-pass";

interface Segment {
  start_time: number;
  end_time: number;
}

/** Transcript segments as they land in the DB after transcription. */
const SEGMENTS: Segment[] = [
  { start_time: 0, end_time: 8 },
  { start_time: 8, end_time: 17 },
  { start_time: 17, end_time: 26 },
];

function makeItem(
  category: KnowledgeCategory,
  title: string,
  timestamps: number[],
): AtomicKnowledge {
  return {
    id: knowledgeNodeId(category, title),
    title,
    category,
    description: "",
    timestamps,
    confidence: 0.7,
    competencyCode: null,
  };
}

/** True when `t` lands inside one of the video's transcript segments — the exact
 *  overlap the client inspector uses to attach a verbatim passage to a cite. */
function withinAnySegment(t: number, segments: Segment[]): boolean {
  return segments.some((s) => t >= s.start_time && t <= s.end_time);
}

describe("GET /graph video-sourced knowledge ↔ transcript-segment overlap", () => {
  beforeEach(async () => {
    resetMocks();
    fake.tables["competencies"].push({
      code: "W-2",
      name: "Shielded Metal Arc Welding",
      trade: TRADE,
      description: null,
    });
    await ensureBaseGraph();

    // A processed video plus its transcript segments (what /videos/:id serves).
    fake.tables["videos"].push({
      id: VIDEO_ID,
      title: "Root Pass Fundamentals",
      trade: TRADE,
      status: "completed",
      description: null,
      competency_codes: [],
      created_at: new Date().toISOString(),
      updated_at: null,
    });
    for (const [i, s] of SEGMENTS.entries()) {
      fake.tables["transcript_segments"].push({
        id: `${VIDEO_ID}-seg-${i}`,
        video_id: VIDEO_ID,
        start_time: s.start_time,
        end_time: s.end_time,
        text: `passage ${i}`,
        confidence: 0.9,
      });
    }
    await syncVideoGraph(VIDEO_ID);
  });

  it("serves a knowledge node whose source timestamps fall within the video's segments", async () => {
    // Distilled concepts cite moments that land inside the transcript segments.
    await syncVideoKnowledge(VIDEO_ID, [
      makeItem("concept", "Root Pass", [3, 12]),
      makeItem("procedure", "Strike An Arc", [20]),
    ]);

    const graph = await getGraph();
    const knowledgeKinds = new Set<string>(KNOWLEDGE_NODE_KINDS);
    const segments = fake.tables["transcript_segments"].map((s) => ({
      start_time: s["start_time"] as number,
      end_time: s["end_time"] as number,
    }));

    // Every distilled item's timestamp was chosen inside a segment.
    expect(segments.length).toBeGreaterThan(0);

    const knowledgeNodes = graph.nodes.filter((n) => knowledgeKinds.has(n.kind));
    expect(knowledgeNodes.length).toBeGreaterThan(0);

    // At least one knowledge node must carry a source for THIS video whose
    // timestamps fall within a transcript segment [start_time, end_time] — the
    // contract the "Source Videos" jump buttons rely on.
    const matching = knowledgeNodes.filter((n) => {
      const sources = (n.meta?.["sources"] ?? []) as Array<{
        videoId: string;
        timestamps: number[];
      }>;
      return sources.some(
        (s) =>
          s.videoId === VIDEO_ID &&
          s.timestamps.length > 0 &&
          s.timestamps.every((t) => withinAnySegment(t, segments)),
      );
    });

    expect(matching.length).toBeGreaterThan(0);

    // And the flattened node-level timestamp union also stays within segments —
    // proves the aggregate the inspector reads is honest, not just the per-source.
    for (const n of matching) {
      const flat = (n.meta?.["timestamps"] ?? []) as number[];
      expect(flat.length).toBeGreaterThan(0);
      for (const t of flat) expect(withinAnySegment(t, segments)).toBe(true);
    }
  });

  it("keeps per-source provenance (videoId + timestamps) on the persisted node", async () => {
    await syncVideoKnowledge(VIDEO_ID, [makeItem("concept", "Root Pass", [3, 12])]);

    const graph = await getGraph();
    const node = graph.nodes.find((n) => n.id === knowledgeNodeId("concept", "Root Pass"));
    expect(node).toBeDefined();

    const sources = (node!.meta?.["sources"] ?? []) as Array<{
      videoId: string;
      timestamps: number[];
    }>;
    const src = sources.find((s) => s.videoId === VIDEO_ID);
    // If distillation or the mirror ever drops the videoId/timestamps carried on
    // a provenance edge, this concept becomes unjumpable — fail loudly here.
    expect(src).toBeDefined();
    expect(src!.timestamps).toEqual([3, 12]);
  });
});
