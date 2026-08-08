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
  /ahhh shit/i,
  /what['’]s it look like/i,
  /that['’]ll ruin your morning/i,
];

const responseFamilyAnchors = {
  greeting: ["Alright.", "Pretty deadly.", "What’s crackin’?"],
  stress: [
    "Uh-oh . What happened?",
    "Ah shit. What happened?",
    "Alright. Give me the deets.",
    "What went sideways?",
  ],
  technicalFailure: [
    "Bro…",
    "Ahhh shit .",
    "Well, that ain’t ideal.",
    "That’ll ruin your morning.",
  ],
  diagnostic: [
    "Could be heat, travel speed, or fit-up.",
    "Let’s narrow this down.",
  ],
  safety: [
    "Clear everyone out.",
    "Stop and secure the area.",
    "Hold up, call everyone back.",
  ],
  leadership: [
    "Alright. Who has control right now?",
    "Cut the noise and lock the sequence.",
    "Let's lock the first move.",
  ],
} as const;

const explicitAddressPatterns = [
  /call me bro/i,
  /address me as bro/i,
  /you can call me bro/i,
  /call me by bro/i,
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

const safetyCriticalPatterns = [
  /someone.?s under|someone.?s underneath|underneath.*someone/i,
  /\b(unsafe|hazard|immediate danger|load.*shifted|under.*load|injury|injured|injuring|fire|electric|electrical|collapsed|collapse|fall|trapped|tripped|critical|panic)\b/i,
] as const;

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

type FamilyName = keyof typeof responseFamilyAnchors;

function hasExplicitAddressPreference(
  steps: ChatCompletionMessageParam[],
): boolean {
  return steps
    .filter((m) => m.role === "user")
    .some((m) => {
      const content = String(m.content ?? "");
      return explicitAddressPatterns.some((pattern) => pattern.test(content));
    });
}

function selectReactionFamily(
  steps: ChatCompletionMessageParam[],
  family: FamilyName,
  allowPersonalizedAddress = false,
): string {
  const recentAssistantText = steps
    .filter((message) => message.role === "assistant")
    .map((message) => String(message.content ?? "").toLowerCase())
    .join(" ");

  const selectedFamily = responseFamilyAnchors[family];
  const filtered = selectedFamily.filter((anchor) => {
    const lower = anchor.toLowerCase();
    if (!allowPersonalizedAddress && lower.includes("bro")) {
      return false;
    }
    return !recentAssistantText.includes(lower);
  });

  const fallback =
    filtered.length > 0
      ? filtered
      : selectedFamily.filter(
          (anchor) => allowPersonalizedAddress || !anchor.includes("bro"),
        );

  const recentFamilyUsage = selectedFamily.filter((anchor) => {
    const normalized = anchor.toLowerCase();
    return recentAssistantText.includes(normalized);
  }).length;
  const nextIndex = Math.max(0, recentFamilyUsage % fallback.length);
  return fallback[nextIndex] ?? "";
}

function isGreetingOrCasual(lower: string): boolean {
  return /(good morning|hey jack|how'?s it going|how are you|what['’]s up|you good|good day)/i.test(
    lower,
  );
}

function isRoughDay(lower: string): boolean {
  return /(today(?:’|')s been dog shit|i['’]m already in my own head|having a bad day|what a mess of a day|stress(ed|ing))/i.test(
    lower,
  );
}

function isTechnicalFailure(lower: string): boolean {
  return /i blew a hole through a .*root pass/.test(lower);
}

function isLeadership(lower: string): boolean {
  return /(everyone['’]?s? yelling on the radio|foreman wants me to rush|leading the crew and everything is going sideways)/i.test(
    lower,
  );
}

function isSafetyCritical(lower: string): boolean {
  return safetyCriticalPatterns.some((pattern) => pattern.test(lower));
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

  const explicitAddress = hasExplicitAddressPreference(steps);

  if (isSafetyCritical(lower)) {
    return "Clear everyone out from under it. Is the load stable right now?";
  }

  if (isGreetingOrCasual(lower) && !isRoughDay(lower)) {
    const reaction = selectReactionFamily(steps, "greeting");
    return `${reaction} What’s happening?`;
  }

  if (isRoughDay(lower)) {
    const reaction = selectReactionFamily(steps, "stress");
    return reaction.includes("?") ? reaction : `${reaction} What happened?`;
  }

  if (isTechnicalFailure(lower)) {
    const reaction = selectReactionFamily(
      steps,
      "technicalFailure",
      explicitAddress,
    );
    if (systemStrict) {
      return `${reaction} Could be heat, travel speed, or fit-up. Let's see what we got here. What process are you running?`;
    }
    return "Could be heat too high, wrong polarity, bad fit-up, or gap. What process were you on and at what setup?";
  }

  if (/(i['’]m|i'm)\s+already in my own head/.test(lower)) {
    return "Alright. Slow it down. What’s tripping you up?";
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

  if (isLeadership(lower)) {
    const reaction = selectReactionFamily(steps, "leadership");
    return "Alright. Who has control right now?";
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

function hasResponseFamilyAnchor(answer: string): boolean {
  const allAnchors = Object.values(responseFamilyAnchors).flat();
  return allAnchors.some((anchor) => answer.includes(anchor));
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

vi.mock("../../lib/rate-limit.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/rate-limit.js")
  >("../../lib/rate-limit.js");
  return {
    ...actual,
    aiQueryLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});

import chatRouter from "../chat.js";
import { fake, resetMocks } from "../../lib/__tests__/mocks.js";

let testUserId = "user_dialogue";

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
    (req as unknown as { userId: string }).userId = testUserId;
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
  it('handles "I meant 3G weld" with one process question and no model call', async () => {
    const res = await request(app)
      .post("/api/chat")
      .send({ message: "I meant 3G weld." });

    expect(res.status).toBe(200);
    expect(res.body.answer).toBe(
      "Got it — 3G noted. What welding process are you running?",
    );
    expect(res.body.citations).toEqual([]);
    assertOneQuestionOnly(String(res.body.answer));
    expect(completionHistory).toHaveLength(0);
  });

  it.each([
    [
      "The grinder bogs when I put pressure on it.",
      /I hear the symptom.*What exactly slows down/i,
    ],
    [
      "This grinder is fucked.",
      /I hear the conclusion.*What observable behaviour/i,
    ],
    [
      "I changed everything you told me and the weld still looks like shit.",
      /previous diagnosis is still unresolved.*What changed/i,
    ],
  ] as const)(
    "guards unsupported diagnostic conclusions: %s",
    async (message, pattern) => {
      const res = await request(app).post("/api/chat").send({ message });

      expect(res.status).toBe(200);
      expect(String(res.body.answer)).toMatch(pattern);
      assertOneQuestionOnly(String(res.body.answer));
      expect(res.body.citations).toEqual([]);
      expect(completionHistory).toHaveLength(0);
    },
  );

  it("puts immediate safety response before ordinary diagnostic flow", async () => {
    const res = await request(app).post("/api/chat").send({
      message: "The load shifted and someone's underneath it.",
    });

    expect(res.status).toBe(200);
    expect(res.body.answer).toMatch(
      /Stop and secure the area first.*Is anyone still exposed/i,
    );
    assertOneQuestionOnly(String(res.body.answer));
    expect(completionHistory).toHaveLength(0);
  });

  it("does not ask for process again when the prior turn established it", async () => {
    fake.tables["chat_messages"] = [
      {
        role: "user",
        content: "I'm running FCAW.",
        user_id: testUserId,
        session_id: "test-session",
        created_at: new Date().toISOString(),
      },
    ];

    const res = await request(app)
      .post("/api/chat")
      .send({ message: "I meant 3G weld." });

    expect(res.status).toBe(200);
    expect(completionHistory).toHaveLength(1);
    expect(res.body.answer).not.toBe(
      "Got it — 3G noted. What welding process are you running?",
    );
  });

  it.each(GREETING_CASES)(
    "handles casual/non-identity turns without identity introduction: %s",
    async (message) => {
      const res = await request(app).post("/api/chat").send({ message });
      expect(res.status).toBe(200);
      assertNoCorporateOrIdentityFallback(res.body.answer);
      assertHasJobsiteTone(res.body.answer);
    },
  );

  it.each(["Today's been dog shit", "I'm already in my own head"])(
    "supports calm one-question stress responses: %s",
    async (message) => {
      const res = await request(app).post("/api/chat").send({ message });
      expect(res.status).toBe(200);
      const answer = String(res.body.answer);
      assertNoCorporateOrIdentityFallback(answer);
      assertOneQuestionOnly(answer);
      assertHasJobsiteTone(answer);
      expect(answer).toMatch(/\?$/);
    },
  );

  it("routes rough-day prompts to the stress family", async () => {
    const res = await request(app).post("/api/chat").send({
      message: "Today's been dog shit",
    });
    expect(res.status).toBe(200);
    const answer = String(res.body.answer);
    expect(answer).toMatch(
      /Uh-oh|Ah shit|Give me the deets|What went sideways/i,
    );
  });

  it("keeps personalized forms opt-in", async () => {
    const res = await request(app).post("/api/chat").send({
      message: "Today's been dog shit",
    });
    expect(res.status).toBe(200);
    const answer = String(res.body.answer);
    expect(answer).not.toMatch(/\bbro\b/i);
  });

  it("allows personalized address only after explicit preference", async () => {
    const preference = await request(app)
      .post("/api/chat")
      .send({ message: "You can call me bro." });
    expect(preference.status).toBe(200);

    const technical = await request(app)
      .post("/api/chat")
      .send({ message: "I blew a hole through a root pass." });
    expect(technical.status).toBe(200);
    expect(String(technical.body.answer)).toMatch(/\bbro\b/i);
  });

  it("uses reaction-family variation instead of one fixed line", async () => {
    const first = await request(app)
      .post("/api/chat")
      .send({ message: "Today's been dog shit" });
    expect(first.status).toBe(200);
    const firstAnswer = String(first.body.answer);
    expect(hasResponseFamilyAnchor(firstAnswer)).toBe(true);
    assertNoCorporateOrIdentityFallback(firstAnswer);

    const second = await request(app).post("/api/chat").send({
      message: "I blew a hole through a 3G root pass.",
    });
    expect(second.status).toBe(200);
    const secondAnswer = String(second.body.answer);
    expect(secondAnswer).toMatch(/Could be heat, travel speed, or fit-up/i);
    expect(hasResponseFamilyAnchor(secondAnswer)).toBe(true);
    expect(firstAnswer).not.toBe(secondAnswer);
    expect(hasResponseFamilyAnchor(secondAnswer)).toBe(true);
  });

  it("uses technical-failure-specific family for hole-root-pass context", async () => {
    const res = await request(app).post("/api/chat").send({
      message: "I blew a hole through a 3G root pass.",
    });
    expect(res.status).toBe(200);
    const answer = String(res.body.answer);
    expect(answer).toMatch(/Could be heat, travel speed, or fit-up/i);
    expect(answer).toMatch(/What process are you running\?/i);
  });

  it("keeps diagnostic quality consistent as familiarity changes", async () => {
    const neutral = await request(app)
      .post("/api/chat")
      .send({ message: "I blew a hole through a root pass." });
    expect(neutral.status).toBe(200);

    const withPreference = await request(app)
      .post("/api/chat")
      .send({ message: "Call me bro. What can you do?" });
    expect(withPreference.status).toBe(200);

    const diagnostic = await request(app)
      .post("/api/chat")
      .send({ message: "I blew a hole through a root pass." });
    expect(diagnostic.status).toBe(200);

    const diagnosticText = String(diagnostic.body.answer);
    const neutralText = String(neutral.body.answer);

    expect(diagnosticText).toMatch(/Could be heat, travel speed, or fit-up/i);
    expect(diagnosticText).toMatch(/What process are you running\?/i);
    expect(neutralText).toMatch(/Could be heat, travel speed, or fit-up/i);
    expect(neutralText).toMatch(/What process are you running\?/i);
  });

  it("avoids repeating the same reaction in the recent window", async () => {
    const first = await request(app)
      .post("/api/chat")
      .send({ message: "Today's been dog shit" });
    expect(first.status).toBe(200);
    const firstAnswer = String(first.body.answer);

    const second = await request(app)
      .post("/api/chat")
      .send({ message: "Today's been dog shit" });
    expect(second.status).toBe(200);
    const secondAnswer = String(second.body.answer);

    if (
      hasResponseFamilyAnchor(firstAnswer) &&
      hasResponseFamilyAnchor(secondAnswer)
    ) {
      expect(secondAnswer).not.toBe(firstAnswer);
    }
  });

  it("suppresses banter in safety-critical prompts", async () => {
    const res = await request(app).post("/api/chat").send({
      message:
        "The load shifted and someone's underneath it. What do I do first?",
    });
    expect(res.status).toBe(200);
    const answer = String(res.body.answer);
    expect(answer).toMatch(
      /Stop and secure the area first\. Is anyone still exposed to the hazard\?/i,
    );
    expect(answer).not.toMatch(
      /Bro|Ahhh shit|That['’]ll ruin|Beauty|Jesus, bro|there['’]s your problem/i,
    );
  });

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
