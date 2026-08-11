import { beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express, type Request } from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

const resolveIdentity = vi.hoisted(() => vi.fn());
const chatCompletion = vi.hoisted(() => vi.fn());

vi.mock("../../lib/supabase.js", async () => {
  const m = await import("../../lib/__tests__/mocks.js");
  return { supabase: m.fake };
});

vi.mock("../../lib/openai.js", async () => {
  const m = await import("../../lib/__tests__/mocks.js");
  return {
    createEmbedding: m.createEmbedding,
    chatCompletion,
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

vi.mock("../../lib/admin-auth.js", () => ({
  resolveIdentity,
}));

import chatRouter from "../chat.js";
import { fake, resetMocks } from "../../lib/__tests__/mocks.js";

const USER_ID = "tester-1";
const PRESENTATION_ID = "clerk-presentation-account";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const APP_SESSION_ID = "22222222-2222-4222-8222-222222222222";
const ORGANIZATION_ID = "33333333-3333-4333-8333-333333333333";
const PILOT_ID = "44444444-4444-4444-8444-444444444444";
const CONSENT_ID = "55555555-5555-4555-8555-555555555555";
const CHAT_SESSION_ID = "77777777-7777-4777-8777-777777777777";

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
    const header = req.headers["x-test-user"];
    if (typeof header === "string" && header.length > 0) {
      req.userId = header;
    }
    next();
  });
  app.use("/api", chatRouter);
  return app;
}

const app = makeApp();

beforeEach(() => {
  resetMocks();
  chatCompletion.mockReset();
  chatCompletion.mockResolvedValue({
    choices: [{ message: { content: "An answer." } }],
  });
  resolveIdentity.mockReset();
  resolveIdentity.mockResolvedValue({
    userId: USER_ID,
    email: "tester@example.test",
    name: "Tester",
    isAdmin: false,
    isPresentation: false,
    classification: "resolved",
  });
  fake.tables.test_sessions = [
    {
      id: SESSION_ID,
      actor_user_id: USER_ID,
      organization_id: ORGANIZATION_ID,
      pilot_id: PILOT_ID,
      status: "active",
      telemetry_status: "granted",
      app_session_id: APP_SESSION_ID,
      chat_session_id: CHAT_SESSION_ID,
      question_count: 0,
      last_activity_at: "2026-07-25T00:00:00.000Z",
      created_at: "2026-07-25T00:00:00.000Z",
      updated_at: "2026-07-25T00:00:00.000Z",
    },
  ];
  fake.tables.telemetry_consents = [
    {
      id: CONSENT_ID,
      actor_user_id: USER_ID,
      organization_id: ORGANIZATION_ID,
      pilot_id: PILOT_ID,
      scope: "telemetry",
      state: "granted",
      privacy_notice_version: "jack-pilot-privacy-2026-07-25",
      consent_version: "jack-pilot-consent-2026-07-25",
      occurred_at: "2026-07-25T00:00:00.000Z",
    },
  ];
  fake.tables.test_events = [];
  fake.tables.pilots = [
    {
      id: PILOT_ID,
      organization_id: ORGANIZATION_ID,
      name: "Pilot",
      status: "active",
    },
  ];
  fake.tables.pilot_memberships = [
    {
      user_id: USER_ID,
      organization_id: ORGANIZATION_ID,
      pilot_id: PILOT_ID,
      role: "tester",
      active: true,
      valid_from: "2026-01-01T00:00:00.000Z",
      valid_until: null,
    },
  ];
  fake.tables.conversation_review_consents = [];
  fake.tables.chat_messages = [];
});

describe("Ask Jack telemetry presentation denial", () => {
  it("does not record a completed Ask Jack event for a restricted presentation identity", async () => {
    resolveIdentity.mockResolvedValue({
      userId: PRESENTATION_ID,
      email: "presentation@example.test",
      name: "Presentation",
      isAdmin: false,
      isPresentation: true,
      classification: "restricted",
    });

    const response = await request(app)
      .post("/api/chat")
      .set("x-test-user", USER_ID)
      .set("x-jack-test-session-id", SESSION_ID)
      .send({ message: "How should I set up this weld?" });

    expect(response.status).toBe(200);
    expect(fake.tables.test_events).toHaveLength(0);
    expect(fake.tables.test_sessions[0]?.question_count).toBe(0);
  });

  it("does not record a failed Ask Jack event when trusted identity resolution is unavailable", async () => {
    resolveIdentity.mockResolvedValue({
      userId: USER_ID,
      email: null,
      name: null,
      isAdmin: false,
      isPresentation: false,
      classification: "unavailable",
    });
    chatCompletion.mockRejectedValueOnce(new Error("chat backend unavailable"));

    const response = await request(app)
      .post("/api/chat")
      .set("x-test-user", USER_ID)
      .set("x-jack-test-session-id", SESSION_ID)
      .send({ message: "What do I do now?" });

    expect(response.status).toBe(500);
    expect(fake.tables.test_events).toHaveLength(0);
    expect(fake.tables.test_sessions[0]?.question_count).toBe(0);
  });

  it("continues to record minimized telemetry for an ordinary consenting tester", async () => {
    const response = await request(app)
      .post("/api/chat")
      .set("x-test-user", USER_ID)
      .set("x-jack-test-session-id", SESSION_ID)
      .send({ message: "How should I set up this weld?" });

    expect(response.status).toBe(200);
    expect(fake.tables.test_events).toHaveLength(1);
    expect(fake.tables.test_events[0]).toMatchObject({
      actor_user_id: USER_ID,
      event_type: "ask_jack_completed",
      metadata: { citation_count: expect.any(Number) },
    });
    expect(fake.tables.test_sessions[0]?.question_count).toBe(1);
  });

  it("stamps canonical chat writes when the participant has current scoped review consent", async () => {
    const reviewConsentId = "66666666-6666-4666-8666-666666666666";
    fake.tables.conversation_review_consents = [
      {
        id: reviewConsentId,
        actor_user_id: USER_ID,
        organization_id: ORGANIZATION_ID,
        pilot_id: PILOT_ID,
        chat_session_id: CHAT_SESSION_ID,
        state: "granted",
        privacy_notice_version: "jack-pilot-privacy-2026-07-25",
        consent_version: "jack-pilot-conversation-review-addendum-2026-08-11",
        occurred_at: "2026-08-11T00:00:00.000Z",
      },
    ];

    const response = await request(app)
      .post("/api/chat")
      .set("x-test-user", USER_ID)
      .set("x-jack-test-session-id", SESSION_ID)
      .set("Cookie", `jack_session=${CHAT_SESSION_ID}`)
      .send({ message: "How should I set up this weld?" });

    expect(response.status).toBe(200);
    expect(fake.tables.chat_messages).toHaveLength(2);
    for (const row of fake.tables.chat_messages) {
      expect(row).toMatchObject({
        user_id: USER_ID,
        organization_id: ORGANIZATION_ID,
        pilot_id: PILOT_ID,
        test_session_id: SESSION_ID,
        conversation_review_consent_id: reviewConsentId,
      });
    }
  });

  it("does not reuse an older cookie grant after another cookie supersedes it", async () => {
    fake.tables.conversation_review_consents = [
      {
        id: "review-consent-old-cookie",
        actor_user_id: USER_ID,
        organization_id: ORGANIZATION_ID,
        pilot_id: PILOT_ID,
        chat_session_id: CHAT_SESSION_ID,
        state: "granted",
        privacy_notice_version: "jack-pilot-privacy-2026-07-25",
        consent_version: "jack-pilot-conversation-review-addendum-2026-08-11",
        occurred_at: "2026-08-11T00:00:00.000Z",
      },
      {
        id: "review-consent-new-cookie",
        actor_user_id: USER_ID,
        organization_id: ORGANIZATION_ID,
        pilot_id: PILOT_ID,
        chat_session_id: "new-cookie-session",
        state: "granted",
        privacy_notice_version: "jack-pilot-privacy-2026-07-25",
        consent_version: "jack-pilot-conversation-review-addendum-2026-08-11",
        occurred_at: "2026-08-11T01:00:00.000Z",
      },
    ];

    const response = await request(app)
      .post("/api/chat")
      .set("x-test-user", USER_ID)
      .set("Cookie", `jack_session=${CHAT_SESSION_ID}`)
      .send({ message: "Keep this conversation outside pilot review." });

    expect(response.status).toBe(200);
    expect(fake.tables.chat_messages).toHaveLength(2);
    for (const row of fake.tables.chat_messages) {
      expect(row).not.toHaveProperty("organization_id");
      expect(row).not.toHaveProperty("conversation_review_consent_id");
    }
  });

  it("fails closed instead of guessing when one chat cookie has grants in multiple pilots", async () => {
    const secondPilotId = "88888888-8888-4888-8888-888888888888";
    fake.tables.pilots.push({
      id: secondPilotId,
      organization_id: ORGANIZATION_ID,
      name: "Second pilot",
      status: "active",
    });
    fake.tables.pilot_memberships.push({
      ...fake.tables.pilot_memberships[0],
      pilot_id: secondPilotId,
    });
    fake.tables.conversation_review_consents = [PILOT_ID, secondPilotId].map(
      (pilotId, index) => ({
        id: `review-consent-${index}`,
        actor_user_id: USER_ID,
        organization_id: ORGANIZATION_ID,
        pilot_id: pilotId,
        chat_session_id: CHAT_SESSION_ID,
        state: "granted",
        privacy_notice_version: "jack-pilot-privacy-2026-07-25",
        consent_version: "jack-pilot-conversation-review-addendum-2026-08-11",
        occurred_at: "2026-08-11T00:00:00.000Z",
      }),
    );

    const response = await request(app)
      .post("/api/chat")
      .set("x-test-user", USER_ID)
      .set("Cookie", `jack_session=${CHAT_SESSION_ID}`)
      .send({ message: "Do not guess my pilot." });

    expect(response.status).toBe(200);
    expect(fake.tables.chat_messages).toHaveLength(2);
    for (const row of fake.tables.chat_messages) {
      expect(row).not.toHaveProperty("organization_id");
      expect(row).not.toHaveProperty("conversation_review_consent_id");
    }
  });
});
