import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { fake, resetMocks } from "./mocks.js";
import {
  ensureBaseGraph,
  reconcileMentorAnswerProvenance,
} from "../memory-graph.js";

const MENTOR_A = "aaaaaaaa-0000-0000-0000-000000000001";
const MENTOR_B = "bbbbbbbb-0000-0000-0000-000000000002";
const SESSION_A = "aaaaaaaa-1111-4111-8111-111111111111";
const SESSION_B = "bbbbbbbb-2222-4222-8222-222222222222";
const ANSWER_A = "aaaaaaaa-3333-4333-8333-333333333333";
const ANSWER_B = "bbbbbbbb-4444-4444-8444-444444444444";
const CONCEPT = "k:concept:shared-field-lesson";

function addConcept(): void {
  fake.tables["knowledge_nodes"].push({
    id: CONCEPT,
    kind: "concept",
    label: "Shared Field Lesson",
    trade: "Welder",
    confidence: 0.9,
    verification_status: "mentor_supplied",
    meta: {},
  });
}

function addMentorSource(
  mentorId: string,
  sessionId: string,
  answerId: string,
): void {
  fake.tables["mentor_profiles"] ??= [];
  fake.tables["interview_sessions"] ??= [];
  fake.tables["interview_answers"] ??= [];
  fake.tables["mentor_profiles"].push({
    id: mentorId,
    name: mentorId,
    trade: "Welder",
  });
  fake.tables["interview_sessions"].push({
    id: sessionId,
    mentor_profile_id: mentorId,
    trade: "Welder",
  });
  fake.tables["interview_answers"].push({
    id: answerId,
    session_id: sessionId,
    mentor_profile_id: mentorId,
    question: "Question",
    answer_text: "Answer",
  });
  fake.tables["knowledge_nodes"].push({
    id: `mentor:${mentorId}`,
    kind: "mentor",
    label: mentorId,
    ref_id: mentorId,
    meta: { mentorProfileId: mentorId },
  });
  fake.tables["knowledge_edges"].push({
    id: `mentor:${mentorId}->${CONCEPT}`,
    source_id: `mentor:${mentorId}`,
    target_id: CONCEPT,
    kind: "knowledge",
    weight: 1,
    meta: {
      mentorProfileId: mentorId,
      answerIds: [answerId],
      answerConfidences: { [answerId]: 0.8 },
      confidence: 0.8,
    },
  });
}

beforeEach(async () => {
  resetMocks();
  await ensureBaseGraph();
  addConcept();
});

describe("mentor provenance reconciliation", () => {
  it("previews a deleted source answer without mutating the graph", async () => {
    addMentorSource(MENTOR_A, SESSION_A, ANSWER_A);
    fake.tables["interview_answers"] = [];

    const result = await reconcileMentorAnswerProvenance();

    expect(result.applied).toBe(false);
    expect(result.actions).toEqual([
      expect.objectContaining({
        action: "delete_edge",
        invalidAnswerIds: [ANSWER_A],
      }),
    ]);
    expect(
      fake.tables["knowledge_edges"].some(
        (edge) => edge["source_id"] === `mentor:${MENTOR_A}`,
      ),
    ).toBe(true);
  });

  it("removes a deleted answer edge but preserves a shared video-sourced node", async () => {
    addMentorSource(MENTOR_A, SESSION_A, ANSWER_A);
    fake.tables["interview_answers"] = [];
    fake.tables["knowledge_nodes"].push({
      id: "video:shared",
      kind: "video",
      label: "Shared video",
    });
    fake.tables["knowledge_edges"].push({
      id: `video:shared->${CONCEPT}`,
      source_id: "video:shared",
      target_id: CONCEPT,
      kind: "knowledge",
      weight: 1,
      meta: { sourceType: "video", confidence: 0.7, videoId: "shared" },
    });

    await reconcileMentorAnswerProvenance({ apply: true });

    expect(
      fake.tables["knowledge_edges"].some(
        (edge) => edge["source_id"] === `mentor:${MENTOR_A}`,
      ),
    ).toBe(false);
    expect(
      fake.tables["knowledge_nodes"].some((node) => node["id"] === CONCEPT),
    ).toBe(true);
    expect(
      fake.tables["knowledge_edges"].some(
        (edge) => edge["source_id"] === "video:shared",
      ),
    ).toBe(true);
  });

  it("removes a reused-profile mismatch while preserving another mentor's valid source", async () => {
    addMentorSource(MENTOR_A, SESSION_A, ANSWER_A);
    addMentorSource(MENTOR_B, SESSION_B, ANSWER_B);
    const mismatched = fake.tables["interview_answers"].find(
      (answer) => answer["id"] === ANSWER_A,
    )!;
    mismatched["mentor_profile_id"] = MENTOR_B;

    const result = await reconcileMentorAnswerProvenance({ apply: true });

    expect(result.actions).toEqual([
      expect.objectContaining({
        mentorProfileId: MENTOR_A,
        invalidAnswerIds: [ANSWER_A],
      }),
    ]);
    expect(
      fake.tables["knowledge_edges"].some(
        (edge) => edge["source_id"] === `mentor:${MENTOR_A}`,
      ),
    ).toBe(false);
    expect(
      fake.tables["knowledge_edges"].some(
        (edge) => edge["source_id"] === `mentor:${MENTOR_B}`,
      ),
    ).toBe(true);
    expect(
      fake.tables["knowledge_nodes"].some((node) => node["id"] === CONCEPT),
    ).toBe(true);
  });

  it("removes a cross-profile session mismatch", async () => {
    addMentorSource(MENTOR_A, SESSION_A, ANSWER_A);
    fake.tables["interview_sessions"][0]!["mentor_profile_id"] = MENTOR_B;

    const result = await reconcileMentorAnswerProvenance({ apply: true });

    expect(result.actions[0]).toMatchObject({
      action: "delete_edge",
      invalidAnswerIds: [ANSWER_A],
    });
  });
});
