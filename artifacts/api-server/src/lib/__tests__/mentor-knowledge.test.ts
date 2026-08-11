import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AtomicKnowledge, KnowledgeCategory } from "../distillation.js";

vi.mock("../supabase.js", async () => {
  const mocks = await import("./mocks.js");
  return { supabase: mocks.fake };
});
vi.mock("../openai.js", async () => {
  const mocks = await import("./mocks.js");
  return {
    createEmbedding: mocks.createEmbedding,
    MODELS: mocks.MODELS,
    openai: mocks.openai,
  };
});

import { embedRegistry, fake, resetMocks } from "./mocks.js";
import {
  ensureBaseGraph,
  knowledgeNodeId,
  listKnowledgeCandidates,
  syncMentorAnswerKnowledge,
  syncVideoGraph,
  syncVideoKnowledge,
} from "../memory-graph.js";

const TRADE = "Welder";
const MENTOR = "aaaaaaaa-0000-0000-0000-000000000001";
const SESSION = "99999999-0000-0000-0000-000000000009";
const ANSWER = "11111111-0000-0000-0000-000000000001";
const BASE_VECTOR = [1, ...Array(15).fill(0)] as number[];
const atSimilarity = (similarity: number): number[] => [
  similarity,
  Math.sqrt(1 - similarity * similarity),
  ...Array(14).fill(0),
];

function item(
  category: KnowledgeCategory,
  title: string,
  confidence = 0.8,
): AtomicKnowledge {
  return {
    id: knowledgeNodeId(category, title),
    title,
    category,
    description: `${title} field explanation`,
    timestamps: [],
    confidence,
    competencyCode: "W-2",
  };
}

function seedSource(
  answerId = ANSWER,
  mentorId = MENTOR,
  sessionId = SESSION,
): void {
  fake.tables["mentor_profiles"] ??= [];
  fake.tables["interview_sessions"] ??= [];
  fake.tables["interview_answers"] ??= [];
  fake.tables["mentor_profiles"].push({
    id: mentorId,
    name: "Alice",
    trade: TRADE,
  });
  fake.tables["interview_sessions"].push({
    id: sessionId,
    mentor_profile_id: mentorId,
    trade: TRADE,
    status: "active",
  });
  fake.tables["interview_answers"].push({
    id: answerId,
    session_id: sessionId,
    mentor_profile_id: mentorId,
    question: "What matters in the field?",
    answer_text: "Keep a steady angle and watch the puddle.",
    skipped: false,
  });
}

async function seedVideoConcept(title: string): Promise<string> {
  const videoId = `video-${title.toLowerCase().replaceAll(" ", "-")}`;
  fake.tables["videos"].push({
    id: videoId,
    title,
    trade: TRADE,
    status: "ready",
    description: null,
    competency_codes: [],
    created_at: new Date().toISOString(),
  });
  await syncVideoGraph(videoId);
  const concept = item("concept", title, 0.7);
  await syncVideoKnowledge(videoId, [concept]);
  return concept.id;
}

beforeEach(async () => {
  resetMocks();
  fake.tables["competencies"].push({
    code: "W-2",
    name: "Shielded Metal Arc Welding",
    trade: TRADE,
    description: null,
  });
  await ensureBaseGraph();
  seedSource();
});

describe("mentor interview ingestion review gate", () => {
  it("queues an exact existing concept without reinforcing the live graph", async () => {
    const canonicalId = await seedVideoConcept("Travel Speed");
    const beforeEdges = fake.tables["knowledge_edges"].length;

    const outcomes = await syncMentorAnswerKnowledge(
      MENTOR,
      "Alice",
      [item("concept", "Travel Speed")],
      {
        answerId: ANSWER,
        sessionId: SESSION,
        trade: TRADE,
      },
    );

    expect(outcomes).toEqual([
      expect.objectContaining({ outcome: "queued", canonicalId: null }),
    ]);
    expect(fake.tables["knowledge_edges"]).toHaveLength(beforeEdges);
    expect(
      fake.tables["knowledge_nodes"].some(
        (node) => node["id"] === `mentor:${MENTOR}`,
      ),
    ).toBe(false);
    const candidate = (fake.tables["knowledge_candidates"] ?? [])[0]!;
    expect(candidate["status"]).toBe("pending");
    expect(
      (candidate["best_matches"] as Array<Record<string, unknown>>)[0],
    ).toMatchObject({
      nodeId: canonicalId,
      similarity: 1,
    });
  });

  it("queues a confident semantic match and a novel concept alike", async () => {
    const canonicalTitle = "Arc Length Control";
    embedRegistry.set(
      `${canonicalTitle}. ${canonicalTitle} field explanation`,
      BASE_VECTOR,
    );
    const canonicalId = await seedVideoConcept(canonicalTitle);
    embedRegistry.set(
      "Holding a Short Arc. Holding a Short Arc field explanation",
      atSimilarity(0.92),
    );

    const outcomes = await syncMentorAnswerKnowledge(
      MENTOR,
      "Alice",
      [
        item("concept", "Holding a Short Arc"),
        item("concept", "A Brand New Field Lesson"),
      ],
      { answerId: ANSWER, sessionId: SESSION, trade: TRADE },
    );

    expect(outcomes.map((outcome) => outcome.outcome)).toEqual([
      "queued",
      "queued",
    ]);
    expect(
      fake.tables["knowledge_nodes"].some(
        (node) =>
          node["id"] === knowledgeNodeId("concept", "A Brand New Field Lesson"),
      ),
    ).toBe(false);
    const candidates = fake.tables["knowledge_candidates"] ?? [];
    expect(candidates).toHaveLength(2);
    const semantic = candidates.find(
      (candidate) => candidate["title"] === "Holding a Short Arc",
    )!;
    expect(
      (semantic["best_matches"] as Array<Record<string, unknown>>)[0]?.[
        "nodeId"
      ],
    ).toBe(canonicalId);
  });

  it("retains verbatim source details for the admin review surface", async () => {
    await syncMentorAnswerKnowledge(
      MENTOR,
      "Alice",
      [item("procedure", "Whip and Pause")],
      {
        answerId: ANSWER,
        sessionId: SESSION,
        trade: TRADE,
      },
    );

    const [candidate] = await listKnowledgeCandidates("pending");
    expect(candidate).toMatchObject({
      mentorProfileId: MENTOR,
      mentorName: "Alice",
      trade: TRADE,
      question: "What matters in the field?",
      answerText: "Keep a steady angle and watch the puddle.",
      competencyCode: "W-2",
      sourceValid: true,
    });
  });

  it("is idempotent and never resets a reviewed candidate", async () => {
    const lesson = item("concept", "Puddle Control");
    const opts = { answerId: ANSWER, sessionId: SESSION, trade: TRADE };
    await syncMentorAnswerKnowledge(MENTOR, "Alice", [lesson], opts);
    const row = fake.tables["knowledge_candidates"][0]!;
    row["status"] = "rejected";
    row["resolution_reason"] = "Needs clarification";
    await syncMentorAnswerKnowledge(MENTOR, "Alice", [lesson], opts);

    expect(fake.tables["knowledge_candidates"]).toHaveLength(1);
    expect(fake.tables["knowledge_candidates"][0]).toMatchObject({
      status: "rejected",
      resolution_reason: "Needs clarification",
    });
  });

  it("keeps existing video ingestion semantics intact", async () => {
    const conceptId = await seedVideoConcept("Heat Input");
    expect(
      fake.tables["knowledge_nodes"].some((node) => node["id"] === conceptId),
    ).toBe(true);
    expect(
      fake.tables["knowledge_edges"].some(
        (edge) =>
          edge["target_id"] === conceptId &&
          String(edge["source_id"]).startsWith("video:"),
      ),
    ).toBe(true);
  });
});
