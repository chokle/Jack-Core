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
  fake.tables.test_sessions = [{
    id: SESSION_ID,
    actor_user_id: USER_ID,
    organization_id: ORGANIZATION_ID,
    pilot_id: PILOT_ID,
    status: "active",
    telemetry_status: "granted",
    telemetry_consent_id: CONSENT_ID,
    app_session_id: APP_SESSION_ID,
    question_count: 0,
    last_activity_at: "2026-07-25T00:00:00.000Z",
    created_at: "2026-07-25T00:00:00.000Z",
    updated_at: "2026-07-25T00:00:00.000Z",
  }];
  fake.tables.telemetry_consents = [{
    id: CONSENT_ID,
    actor_user_id: USER_ID,
    organization_id: ORGANIZATION_ID,
    pilot_id: PILOT_ID,
    scope: "telemetry",
    state: "granted",
    privacy_notice_version: "jack-pilot-privacy-2026-07-25",
    consent_version: "jack-pilot-consent-2026-07-25",
    occurred_at: "2026-07-25T00:00:00.000Z",
  }];
  fake.tables.test_events = [];
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
});
