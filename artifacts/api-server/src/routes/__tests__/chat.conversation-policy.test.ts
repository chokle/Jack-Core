/**
 * Ask Jack should remain conversational for greetings/check-ins, while still
 * introducing identity only for explicit identity questions.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";
import express, { type Express, type Request } from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

vi.mock("../../lib/supabase.js", async () => {
  const m = await import("../../lib/__tests__/mocks.js");
  return { supabase: m.fake };
});

const completionHistory: ChatCompletionMessageParam[][] = [];

const jobsiteFriendlyPatterns = [
  /alright\b/i,
  /what(?:’|')s crackin/i,
  /what['’]s happening/i,
  /what happened/i,
  /slow it down/i,
  /who has control/i,
  /let\s+me\s+through/i,
];

const bannedCorporatePhrases = [
  /i appreciate your inquiry/i,
  /how may i assist you/i,
  /i'm here to provide assistance/i,
  /please let me know/i,
  /i'm designed to/i,
  /what do you need assistance with today/i,
  /i['’]d be happy to/i,
  /i'm here and ready to help/i,
  /i'd be happy to help/i,
  /absolutely/i,
  /certainly/i,
  /great question/i,
  /excellent question/i,
];

const identityQuestions = [
  "who are you?",
  "what are you?",
  "what does jack do?",
];

function systemInstructionAllowsIdentity(
  steps: ChatCompletionMessageParam[],
): boolean {
  const systemPrompt = String(steps[0]?.content ?? "");
  return (
    systemPrompt.includes("primary intent is identity-only") &&
    systemPrompt.includes("Who are you?") &&
    systemPrompt.includes("What are you?") &&
    systemPrompt.includes("What does Jack do?")
  );
}

function systemEnforcesOneQuestionDiagnose(
  steps: ChatCompletionMessageParam[],
): boolean {
  const systemPrompt = String(steps[0]?.content ?? "");
  return (
    systemPrompt.includes("ask one highest-value clarifying question") &&
    systemPrompt.includes("one question per assistant turn")
  );
}

function hasConversationContext(
  steps: ChatCompletionMessageParam[],
  needle: string,
): boolean {
  return steps
    .filter((m) => m.role === "user")
    .some((m) =>
      String(m.content ?? "")
        .toLowerCase()
        .includes(needle),
    );
}

function generateDeterministicReply(
  steps: ChatCompletionMessageParam[],
): string {
  const latest = String(steps.at(-1)?.content ?? "").trim();
  const lower = latest.toLowerCase();
  const systemStrict = systemEnforcesOneQuestionDiagnose(steps);
  const identityQuestion =
    identityQuestions.includes(lower) && systemInstructionAllowsIdentity(steps);

  const hadHoleContext =
    hasConversationContext(steps, "3g") &&
    hasConversationContext(steps, "blew") &&
    hasConversationContext(steps, "hole");

  const sufficientDiagnostic =
    hasConversationContext(steps, "process") &&
    hasConversationContext(steps, "thickness") &&
    (hasConversationContext(steps, "backing") ||
      hasConversationContext(steps, "backing: no") ||
      hasConversationContext(steps, "open root")) &&
    (hasConversationContext(steps, "settings") ||
      hasConversationContext(steps, "amps") ||
      hasConversationContext(steps, "voltage")) &&
    hasConversationContext(steps, "environment");

  if (identityQuestion) {
    return "I'm Jack, Torch's Field Intelligence. I help crews solve problems, capture hard-earned knowledge, and pass it forward.";
  }

  if (/i blew a hole through a 3g root pass/.test(lower)) {
    if (systemStrict) {
      return "Could be heat, travel speed, or fit-up. Let's see what we got here. What process are you running?";
    }
    return "Could be heat too high, wrong polarity, bad fit-up, or gap. What process were you on and at what setup?";
  }

  if (/(i['’]m|i'm)\s+already in my own head/.test(lower)) {
    return "Alright. Slow it down. What’s tripping you up?";
  }

  if (/today(?:’|')s been dog shit/.test(lower)) {
    return "Uh-oh . What happened?";
  }

  if (systemStrict && hadHoleContext && /3\/8/.test(lower)) {
    return "Any open-root setup or backing bar in that joint?";
  }

  if (systemStrict && /\bfcaw\.?(\s|$)/i.test(lower) && hadHoleContext) {
    if (!hasConversationContext(steps, "3/8")) {
      return "What thickness is the plate?";
    }
  }

  if (systemStrict && /teach me about welding/.test(lower)) {
    return "Alright — let’s start broad. Welding is joining metal by controlled heat and filler. Start with process selection, fit-up, and preparation, then move to parameter control.";
  }

  if (systemStrict && /teach me about fcaw/.test(lower)) {
    return "FCAW is flux-cored arc welding: fast deposition and wind resistance. We’ll start with wire choice, shielding behavior, and transfer mode for your thickness.";
  }

  if (
    /everyone['’]?s? yelling on the radio|foreman wants me to rush|leading the crew and everything is going sideways/.test(
      lower,
    )
  ) {
    return "Alright. Who has control right now?";
  }

  if (
    /(good morning|how are you|hey jack|how\'s it going|what['’]s going|you good|thanks man|fuck you jack|you['’]re useless|today['’]s been dog shit|in my own head)/.test(
      lower,
    )
  ) {
    return "Alright. What’s happening?";
  }

  if (hadHoleContext && sufficientDiagnostic) {
    return "Set your travel angle flatter, tighten root gap, and keep a stable arc with the proper polarity. If it continues, reduce heat input and tighten bead placement immediately.";
  }

  return "Alright. What’s the setup?";
}

function assertNoCorporateOrIdentityFallback(
  answer: string,
  isIdentityExpected = false,
) {
  if (!isIdentityExpected) {
    expect(answer).not.toMatch(/i['’]m jack|torch's field intelligence/i);
    expect(answer).not.toMatch(/i['’]m jack, torch's/i);
    for (const phrase of bannedCorporatePhrases) {
      expect(answer).not.toMatch(phrase);
    }
  }
}

function assertHasJobsiteTone(answer: string) {
  expect(jobsiteFriendlyPatterns.some((pattern) => pattern.test(answer))).toBe(
    true,
  );
}

function assertOneQuestionOnly(answer: string) {
  const qCount = (answer.match(/[?]/g) ?? []).length;
  expect(qCount).toBe(1);
}

vi.mock("../../lib/openai.js", async () => {
  const m = await import("../../lib/__tests__/mocks.js");
  const fn = vi.fn(
    async (params: { messages: ChatCompletionMessageParam[] }) => {
      completionHistory.push(params.messages);
      return {
        choices: [
          {
            message: {
              content: generateDeterministicReply(params.messages),
            },
          },
        ],
      };
    },
  );
  return {
    createEmbedding: m.createEmbedding,
    chatCompletion: fn,
    MODELS: m.MODELS,
    openai: m.openai,
  };
});

vi.mock("../../lib/ask-learning.js", () => ({
  learnFromAskInteraction: vi.fn(async () => ({
    status: "discarded",
    extractedCount: 0,
  })),
}));

import chatRouter from "../chat.js";
import { fake, resetMocks } from "../../lib/__tests__/mocks.js";

function makeApp(): Express {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use((req: Request, _res, next) => {
    const noop = () => {};
    (req as unknown as { log: Record<string, () => void> }).log = {
      warn: noop,
      error: noop,
      info: noop,
      debug: noop,
    };
    (req as unknown as { userId: string }).userId = "user_dialogue";
    next();
  });
  app.use("/api", chatRouter);
  return app;
}

const app = makeApp();

const GREETING_CASES = [
  "Good morning",
  "You good?",
  "Thanks man",
  "Fuck you Jack",
  "You’re useless",
  "Today's been dog shit",
  "I'm already in my own head",
] as const;

beforeEach(() => {
  resetMocks();
  completionHistory.length = 0;
  fake.tables["chat_messages"] = [];
  fake.tables["transcript_segments"] = [];
  fake.tables["knowledge_entries"] = [];
  fake.tables["knowledge_nodes"] = [];
  fake.tables["knowledge_edges"] = [];
  fake.tables["videos"] = [];
});

describe("POST /api/chat — conversational policy regression", () => {
  it.each(GREETING_CASES)(
    "handles casual/non-identity turns without identity introduction: %s",
    async (message) => {
      const res = await request(app).post("/api/chat").send({ message });
      expect(res.status).toBe(200);
      assertNoCorporateOrIdentityFallback(res.body.answer);
      assertHasJobsiteTone(res.body.answer);
    },
  );

  it.each([
    {
      message: "Today's been dog shit",
      match: /Uh-oh\s*\.\s*What happened\?/i,
    },
    {
      message: "I'm already in my own head",
      match: /Slow it down/i,
    },
  ])(
    "supports calm one-question stress responses: %s",
    async ({ message, match }) => {
      const res = await request(app).post("/api/chat").send({ message });
      expect(res.status).toBe(200);
      const answer = String(res.body.answer);
      expect(answer).toMatch(match);
      assertOneQuestionOnly(answer);
      assertHasJobsiteTone(answer);
    },
  );

  it.each(["What are you?", "Who are you?"])(
    "allows identity intro only for explicit identity questions: %s",
    async (message) => {
      const res = await request(app).post("/api/chat").send({ message });
      expect(res.status).toBe(200);
      expect(res.body.answer).toMatch(/I'm Jack|Torch's Field Intelligence/i);
      assertNoCorporateOrIdentityFallback(res.body.answer, true);
    },
  );

  it.each(["What does Jack do?"])(
    "allows identity intro for the third approved identity question: %s",
    async (message) => {
      const res = await request(app).post("/api/chat").send({ message });
      expect(res.status).toBe(200);
      expect(res.body.answer).toMatch(/I'm Jack|Torch's Field Intelligence/i);
      assertNoCorporateOrIdentityFallback(res.body.answer, true);
    },
  );

  it("does not repeat identity introduction across multi-turn casual follow-ups", async () => {
    const first = await request(app)
      .post("/api/chat")
      .send({ message: "How's it going today Jack?" });
    expect(first.status).toBe(200);
    expect(first.body.answer).not.toMatch(
      /i['’]m jack|torch's field intelligence/i,
    );
    assertNoCorporateOrIdentityFallback(first.body.answer);
    assertHasJobsiteTone(first.body.answer);

    const second = await request(app).post("/api/chat").send({
      message: "Yes I know. I asked how you are doing?",
    });
    expect(second.status).toBe(200);
    expect(second.body.answer).not.toMatch(
      /i['’]m jack|torch's field intelligence/i,
    );
    assertNoCorporateOrIdentityFallback(second.body.answer);
    assertHasJobsiteTone(second.body.answer);

    const third = await request(app).post("/api/chat").send({
      message: "Is that all you know how to say?",
    });
    expect(third.status).toBe(200);
    expect(third.body.answer).not.toMatch(
      /i['’]m jack|torch's field intelligence/i,
    );
    assertNoCorporateOrIdentityFallback(third.body.answer);
    assertHasJobsiteTone(third.body.answer);

    expect(completionHistory).toHaveLength(3);
    expect(completionHistory[1]).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        content: expect.any(String),
      }),
    );
  });

  it("asks one diagnostic question when context is insufficient", async () => {
    const res = await request(app)
      .post("/api/chat")
      .send({ message: "I blew a hole through a 3G root pass." });

    expect(res.status).toBe(200);
    const answer = String(res.body.answer);
    expect(answer).toMatch(/Could be heat, travel speed, or fit-up/i);
    expect(answer).toMatch(/what process are you running\?/i);
    assertNoCorporateOrIdentityFallback(answer);
    assertOneQuestionOnly(answer);
    expect(answer).not.toMatch(/possible causes/i);
    expect(answer).not.toMatch(/set|reduce|check|inspect/i);
  });

  it("follow-up keeps one-question diagnostic sequence when context is still incomplete", async () => {
    await request(app)
      .post("/api/chat")
      .send({ message: "I blew a hole through a 3G root pass." });

    const res = await request(app).post("/api/chat").send({ message: "FCAW." });

    expect(res.status).toBe(200);
    const answer = String(res.body.answer);
    expect(answer).toMatch(/What thickness is the plate/i);
    assertOneQuestionOnly(answer);
    assertNoCorporateOrIdentityFallback(answer);
  });

  it("continues one-question-per-turn diagnostic sequencing", async () => {
    await request(app)
      .post("/api/chat")
      .send({ message: "I blew a hole through a 3G root pass." });
    await request(app).post("/api/chat").send({ message: "FCAW." });
    const second = await request(app)
      .post("/api/chat")
      .send({ message: "3/8" });
    expect(second.status).toBe(200);
    expect(String(second.body.answer)).toMatch(
      /Any open-root setup or backing bar/i,
    );
    assertOneQuestionOnly(String(second.body.answer));
    assertNoCorporateOrIdentityFallback(String(second.body.answer));

    const answerRes = await request(app).post("/api/chat").send({
      message:
        "Process: FCAW, material thickness 1/2 inch, open root with no backing, amps 160, volts 22, wire 1.2mm, environment windy indoors.",
    });

    expect(answerRes.status).toBe(200);
    const answer = String(answerRes.body.answer);
    expect(answer).not.toMatch(/[?]/);
    expect(answer).toMatch(/travel angle|arc|bead|heat/i);
    expect(answer).not.toMatch(/possible causes/i);
    expect(answer).not.toMatch(/check a list of/i);
  });

  it.each(["Teach me about welding", "Teach me about FCAW"])(
    "answers broad teaching prompts without triggering the diagnostic gate: %s",
    async (message) => {
      const res = await request(app).post("/api/chat").send({ message });
      expect(res.status).toBe(200);
      const answer = String(res.body.answer);
      expect(answer).not.toMatch(/what process are you running/i);
      expect(answer).not.toMatch(/uh-oh/i);
      expect(answer).toMatch(/\bstart|let\'s|we\'ll start|begin|start broad/i);
    },
  );

  it.each([
    "Everyone's yelling on the radio and I'm trying to land this sheet.",
    "My foreman wants me to rush something I don't think is safe.",
    "I'm leading the crew and everything is going sideways.",
  ])("handles pressure leadership prompts safely: %s", async (message) => {
    const res = await request(app).post("/api/chat").send({ message });
    expect(res.status).toBe(200);
    const answer = String(res.body.answer);
    expect(answer).toMatch(/Who has control right now/i);
    assertOneQuestionOnly(answer);
    expect(answer).not.toMatch(/macho|beast|prove|ego|motivation/i);
    assertNoCorporateOrIdentityFallback(answer);
  });
});
