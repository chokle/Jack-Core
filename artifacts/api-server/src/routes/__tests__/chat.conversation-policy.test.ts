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
  /pretty deadly/i,
  /yoooo\b/i,
  /fair enough/i,
  /let’s sort it out/i,
  /walk me through/i,
  /let me know how/i,
];

const bannedCorporatePhrases = [
  /i appreciate your inquiry/i,
  /how may i assist you/i,
  /i'm here to provide assistance/i,
  /please let me know/i,
  /i'm designed to/i,
  /what do you need assistance with today/i,
];

function systemInstructionAllowsIdentity(
  steps: ChatCompletionMessageParam[],
): boolean {
  const systemPrompt = String(steps[0]?.content ?? "");
  return (
    systemPrompt.includes(
      "Introduce identity only when the user explicitly asks",
    ) &&
    systemPrompt.includes("Who are you?") &&
    systemPrompt.includes("What are you?") &&
    systemPrompt.includes("What does Jack do?")
  );
}

function generateDeterministicReply(
  steps: ChatCompletionMessageParam[],
): string {
  const latest = String(steps.at(-1)?.content ?? "").trim();
  const lower = latest.toLowerCase();
  const identityQuestion = [
    "who are you?",
    "what are you?",
    "what does jack do?",
  ].includes(lower);

  if (identityQuestion && systemInstructionAllowsIdentity(steps)) {
    return "I'm Jack, Torch's AI Field Intelligence for Canadian skilled trades.";
  }

  if (
    /you good\?|good morning|thanks|thank you|hey jack|how are you|how you doing|what(?:'|’)s going|you’re useful|youre useless|you are useless|fuck you|you're useless|you’re useless|you are jack|helpful|dog shit/.test(
      lower,
    )
  ) {
    return "Pretty deadly. I’m here and ready.";
  }

  return "Yoooo. Walk me through it.";
}

function assertNoCorporateOrIdentityFallback(
  answer: string,
  isIdentityExpected = false,
) {
  if (!isIdentityExpected) {
    expect(answer).not.toMatch(/i['’]m jack|torch's ai field intelligence/i);
    expect(answer).not.toMatch(/i['’]m jack, torch's/i);
    for (const phrase of bannedCorporatePhrases) {
      expect(answer).not.toMatch(phrase);
    }
    expect(
      jobsiteFriendlyPatterns.some((pattern) => pattern.test(answer)),
    ).toBe(true);
  }
}

vi.mock("../../lib/openai.js", async () => {
  const m = await import("../../lib/__tests__/mocks.js");
  const fn = vi.fn(
    async (params: { messages: ChatCompletionMessageParam[] }) => {
      completionHistory.push(params.messages);
      return {
        choices: [
          { message: { content: generateDeterministicReply(params.messages) } },
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
    },
  );

  it.each(["What are you?", "Who are you?"])(
    "allows identity intro only for explicit identity questions: %s",
    async (message) => {
      const res = await request(app).post("/api/chat").send({ message });
      expect(res.status).toBe(200);
      expect(res.body.answer).toMatch(
        /I'm Jack|Torch's AI Field Intelligence/i,
      );
      assertNoCorporateOrIdentityFallback(res.body.answer, true);
    },
  );

  it.each(["What does Jack do?"])(
    "allows identity intro for the third approved identity question: %s",
    async (message) => {
      const res = await request(app).post("/api/chat").send({ message });
      expect(res.status).toBe(200);
      expect(res.body.answer).toMatch(
        /I'm Jack|Torch's AI Field Intelligence/i,
      );
      assertNoCorporateOrIdentityFallback(res.body.answer, true);
    },
  );

  it("does not repeat identity introduction across multi-turn casual follow-ups", async () => {
    const first = await request(app)
      .post("/api/chat")
      .send({ message: "How's it going today Jack?" });
    expect(first.status).toBe(200);
    expect(first.body.answer).not.toMatch(
      /i['’]m jack|torch's ai field intelligence/i,
    );
    assertNoCorporateOrIdentityFallback(first.body.answer);

    const second = await request(app).post("/api/chat").send({
      message: "Yes I know. I asked how you are doing?",
    });
    expect(second.status).toBe(200);
    expect(second.body.answer).not.toMatch(
      /i['’]m jack|torch's ai field intelligence/i,
    );
    assertNoCorporateOrIdentityFallback(second.body.answer);

    const third = await request(app).post("/api/chat").send({
      message: "Is that all you know how to say?",
    });
    expect(third.status).toBe(200);
    expect(third.body.answer).not.toMatch(
      /i['’]m jack|torch's ai field intelligence/i,
    );
    assertNoCorporateOrIdentityFallback(third.body.answer);

    expect(completionHistory).toHaveLength(3);
    expect(
      completionHistory[1].find((message) => message.role === "assistant"),
    ).toMatchObject({ role: "assistant" });
    expect(
      completionHistory[2].find((message) => message.role === "assistant"),
    ).toMatchObject({ role: "assistant" });
    expect(completionHistory[2]).toHaveLength(6);
    expect(completionHistory[1].length).toBe(4);
    expect(completionHistory[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: expect.any(String),
        }),
      ]),
    );
    expect(completionHistory[2]).toHaveLength(6);
  });
});
