import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../supabase.js", async () => {
  const m = await import("./mocks.js");
  return { supabase: m.fake };
});

const runMentorAnswerDistillation = vi.hoisted(() => vi.fn());
vi.mock("../distillation.js", () => ({ runMentorAnswerDistillation }));
vi.mock("../memory-graph.js", () => ({
  verifyAndRecordGraphWrite: vi.fn(),
}));

import { learnFromAskInteraction } from "../ask-learning.js";
import { fake, resetMocks } from "./mocks.js";

beforeEach(() => {
  resetMocks();
  runMentorAnswerDistillation.mockReset();
  fake.tables["mentor_profiles"] = [
    {
      id: "11111111-1111-1111-1111-111111111111",
      name: "Test Contributor",
      trade: "Welder",
      contributor_user_id: "user_test",
      created_at: "2026-07-29T00:00:00Z",
    },
  ];
});

describe("Ask Jack explicit correction learning", () => {
  it("queues a durable candidate instead of writing directly to Living Memory", async () => {
    const result = await learnFromAskInteraction({
      userId: "user_test",
      chatMessageId: "22222222-2222-2222-2222-222222222222",
      sessionId: "33333333-3333-3333-3333-333333333333",
      message:
        "Correction: FCAW-S does not require shielding gas. Supersede the earlier claim that it does.",
    });

    expect(result).toMatchObject({
      status: "pending",
      extractedCount: 1,
    });
    expect(runMentorAnswerDistillation).not.toHaveBeenCalled();
    expect(fake.tables["knowledge_candidates"]).toContainEqual(
      expect.objectContaining({
        id: "correction:22222222-2222-2222-2222-222222222222",
        status: "pending",
        mentor_profile_id: "11111111-1111-1111-1111-111111111111",
      }),
    );
    expect(fake.tables["knowledge_nodes"]).toHaveLength(0);
    expect(fake.tables["knowledge_edges"]).toHaveLength(0);
  });

  it("queues Core identity proposals without applying them to the graph", async () => {
    const result = await learnFromAskInteraction({
      userId: "user_test",
      chatMessageId: "44444444-4444-4444-4444-444444444444",
      sessionId: "55555555-5555-5555-5555-555555555555",
      message:
        "Treat this correction as Jack's canonical self-description: Jack is something else.",
    });
    expect(result.status).toBe("pending");
    expect(fake.tables["knowledge_candidates"]).toContainEqual(
      expect.objectContaining({
        id: "core-correction:44444444-4444-4444-4444-444444444444",
        status: "pending",
      }),
    );
    expect(fake.tables["knowledge_nodes"]).toHaveLength(0);
  });
});
