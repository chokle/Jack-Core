import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../supabase.js", async () => {
  const m = await import("./mocks.js");
  return { supabase: m.fake };
});

import type { SralReflectionInput } from "../sral.js";
import { resetMocks, fake } from "./mocks.js";
import { runSralReflection, queueSralReflection } from "../sral.js";

const actor = "user_123";
const session = "11111111-1111-4111-8111-111111111111";
const subsystem = "chat";

function makeInput(
  overrides: Partial<SralReflectionInput> = {},
): SralReflectionInput {
  return {
    actorUserId: actor,
    sessionId: session,
    interactionReference: `msg-${Math.random()}`,
    subsystem,
    userMessage: "I mean 3G weld. What should I do next?",
    assistantAnswer: "What is your material thickness and base metal?",
    learning: {
      status: "verified",
      extractedCount: 2,
      summary: "Captured a reusable welding-context insight.",
      supportingEvidenceRefs: ["insight:1", "insight:2"],
      objectiveSolved: false,
      assumptionNotes: ["Known context was narrow."],
    },
    ...overrides,
  };
}

beforeEach(() => {
  resetMocks();
  fake.tables["sral_proposals"] = [];
});

describe("SRAL reflection pipeline", () => {
  it("records one ledger row and blocks proposals when recurrence evidence is insufficient", async () => {
    const result = await runSralReflection(
      makeInput({
        learning: {
          ...makeInput().learning,
          extractedCount: 1,
          supportingEvidenceRefs: ["insight:1"],
        },
      }),
    );

    expect(result.proposalCreated).toBe(false);
    expect(result.proposalStatus).toBe("blocked_by_evidence");
    expect(fake.tables["sral_learning_ledger"]).toHaveLength(1);
    expect(fake.tables["sral_proposals"]).toHaveLength(0);
  });

  it("creates a reviewable proposal once recurring verified reflections repeat", async () => {
    const input = makeInput({
      interactionReference: "msg-first",
      learning: {
        status: "verified",
        extractedCount: 2,
        summary: "Captured a reusable pattern.",
        supportingEvidenceRefs: ["insight:1", "insight:2"],
        objectiveSolved: true,
      },
    });
    const inputTwo = makeInput({
      interactionReference: "msg-second",
      learning: {
        ...input.learning,
        objectiveSolved: true,
      },
    });

    await runSralReflection(input);
    const second = await runSralReflection(inputTwo);

    expect(second.proposalCreated).toBe(true);
    expect(second.proposalStatus).toBe("awaiting_review");
    expect(fake.tables["sral_learning_ledger"]).toHaveLength(2);
    expect(fake.tables["sral_proposals"]).toHaveLength(1);
  });

  it("does not create proposals without minimum evidence references", async () => {
    const first = makeInput({
      interactionReference: "msg-e1",
      learning: {
        ...makeInput().learning,
        supportingEvidenceRefs: ["only:one"],
        extractedCount: 1,
      },
    });
    const second = makeInput({
      interactionReference: "msg-e2",
      learning: {
        ...first.learning,
        supportingEvidenceRefs: ["only:two"],
        extractedCount: 1,
      },
    });

    await runSralReflection(first);
    const secondResult = await runSralReflection(second);

    expect(secondResult.proposalCreated).toBe(false);
    expect(secondResult.proposalStatus).toBe("not_required");
    expect(fake.tables["sral_proposals"]).toHaveLength(0);
  });

  it("blocks proposals when constitution gate fails", async () => {
    const first = makeInput({
      interactionReference: "msg-risk-1",
      learning: {
        status: "verified",
        extractedCount: 2,
        summary: "Unsafe instruction candidate.",
        supportingEvidenceRefs: ["r:1", "r:2"],
        objectiveSolved: true,
        riskSignals: ["unsafe_or_unverified_instruction"],
      },
    });
    const second = makeInput({
      interactionReference: "msg-risk-2",
      learning: {
        ...first.learning,
        objectiveSolved: true,
      },
    });

    await runSralReflection(first);
    const secondResult = await runSralReflection(second);

    expect(secondResult.proposalCreated).toBe(false);
    expect(secondResult.proposalStatus).toBe("blocked_by_constitution");
    expect(fake.tables["sral_proposals"]).toHaveLength(0);
  });

  it("is idempotent for the same interaction reference", async () => {
    const first = makeInput({
      interactionReference: "msg-idem",
      learning: {
        status: "verified",
        extractedCount: 2,
        objectiveSolved: false,
        summary: "repeat test",
        supportingEvidenceRefs: ["id:1", "id:2"],
      },
    });
    const firstResult = await runSralReflection(first);
    const secondResult = await runSralReflection(first);

    expect(firstResult.skipped).toBe(false);
    expect(secondResult.skipped).toBe(true);
    expect(fake.tables["sral_learning_ledger"]).toHaveLength(1);
    expect(
      fake.tables["sral_learning_ledger"][0]["interaction_reference"],
    ).toBe("msg-idem");
  });

  it("queueSralReflection never blocks ask completion because it is fire-and-forget", () => {
    const input = makeInput({ interactionReference: "msg-queue" });

    expect(() => queueSralReflection(input)).not.toThrow();
  });
});
