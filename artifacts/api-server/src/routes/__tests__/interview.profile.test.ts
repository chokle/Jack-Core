import { beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express, type Request } from "express";
import request from "supertest";

vi.mock("../../lib/supabase.js", async () => {
  const mocks = await import("../../lib/__tests__/mocks.js");
  return { supabase: mocks.fake };
});

vi.mock("../../lib/openai.js", () => ({
  createEmbedding: vi.fn(async () => [1, 0, 0]),
  chatCompletion: vi.fn(),
  MODELS: {
    chat: "test-chat",
    distill: "test-distill",
    embedding: "test-embedding",
    transcription: "test-transcription",
  },
  openai: { audio: { transcriptions: { create: vi.fn() } } },
}));

vi.mock("../../lib/interview.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../lib/interview.js")>();
  return {
    ...actual,
    generateNextQuestion: vi.fn(async () => ({
      question: "What field lesson should an apprentice learn first?",
      category: "field_judgment",
      topic: "first lesson",
      complete: false,
    })),
  };
});

vi.mock("../../lib/rate-limit.js", () => ({
  aiInterviewLimiter: (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));

import interviewRouter from "../interview.js";
import { fake, resetMocks } from "../../lib/__tests__/mocks.js";
import { generateNextQuestion } from "../../lib/interview.js";

const USER_A = "user_account_a";
const USER_B = "user_account_b";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res, next) => {
    const noop = () => {};
    (req as unknown as { log: Record<string, () => void> }).log = {
      warn: noop,
      error: noop,
      info: noop,
      debug: noop,
    };
    const user = req.headers["x-test-user"];
    if (typeof user === "string") {
      (req as unknown as { userId: string }).userId = user;
    }
    next();
  });
  app.use("/api", interviewRouter);
  return app;
}

const app = makeApp();

beforeEach(() => {
  resetMocks();
  fake.tables["mentor_profiles"] = [
    {
      id: "profile-a",
      contributor_user_id: USER_A,
      name: "Derek Chok",
      trade: "Welder",
      trade_input: "Welding",
      years_experience: 18,
      specialties: ["TIG"],
      region: "British Columbia",
      background: "Industrial repair welding.",
      created_at: "2026-07-12T00:00:00.000Z",
    },
    {
      id: "profile-b",
      contributor_user_id: USER_B,
      name: "Another Contributor",
      trade: "Carpenter",
      trade_input: "Carpentry",
      specialties: [],
      created_at: "2026-07-13T00:00:00.000Z",
    },
  ];
  fake.tables["interview_sessions"] = [];
});

describe("account-bound interview profile", () => {
  it("restores only the signed-in contributor's saved intake fields", async () => {
    const response = await request(app)
      .get("/api/interview/profile")
      .set("x-test-user", USER_A);

    expect(response.status).toBe(200);
    expect(response.body.profile).toMatchObject({
      id: "profile-a",
      name: "Derek Chok",
      trade: "Welder",
      tradeInput: "Welding",
      yearsExperience: 18,
      specialties: ["TIG"],
      region: "British Columbia",
      background: "Industrial repair welding.",
    });
    expect(response.body.profile.name).not.toBe("Another Contributor");
  });

  it("rejects the shared presentation identity at the interview boundary", async () => {
    fake.tables["mentor_profiles"].push({
      id: "presentation-profile",
      contributor_user_id: "presentation-demo",
      name: "Previous Guest",
      trade: "Welder",
      trade_input: "Welding",
      created_at: "2026-07-14T00:00:00.000Z",
    });

    const response = await request(app)
      .get("/api/interview/profile")
      .set("x-test-user", "presentation-demo");

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: "Unauthorized — sign in required.",
    });
  });

  it("updates and reuses the account profile instead of creating a duplicate", async () => {
    const response = await request(app)
      .post("/api/interview/sessions")
      .set("x-test-user", USER_A)
      .send({
        name: "Derek Chok",
        trade: "Welding",
        yearsExperience: 19,
        specialties: ["TIG", "Combo Disc"],
        region: "British Columbia",
        background: "Industrial repair welding.",
        focus: "Field Note: safe combo-disc use in tight repair access.",
      });

    expect(response.status).toBe(201);
    expect(response.body.mentorProfileId).toBe("profile-a");
    expect(fake.tables["mentor_profiles"]).toHaveLength(2);
    expect(
      fake.tables["mentor_profiles"].find((row) => row["id"] === "profile-a"),
    ).toMatchObject({
      years_experience: 19,
      specialties: ["TIG", "Combo Disc"],
      background: "Industrial repair welding.",
    });
    expect(fake.tables["interview_sessions"][0]).toMatchObject({
      mentor_profile_id: "profile-a",
      contributor_user_id: USER_A,
    });
    expect(generateNextQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Derek Chok", yearsExperience: 19 }),
      [],
      "Field Note: safe combo-disc use in tight repair access.",
    );
  });

  it("does not let the shared presentation identity create an owned interview", async () => {
    fake.tables["mentor_profiles"].push({
      id: "presentation-profile",
      contributor_user_id: "presentation-demo",
      name: "Previous Guest",
      trade: "Welder",
      trade_input: "Welding",
      created_at: "2026-07-14T00:00:00.000Z",
    });

    const response = await request(app)
      .post("/api/interview/sessions")
      .set("x-test-user", "presentation-demo")
      .send({ name: "Current Guest", trade: "Electrical" });

    expect(response.status).toBe(401);
    expect(fake.tables["mentor_profiles"]).toHaveLength(3);
    expect(
      fake.tables["mentor_profiles"].find(
        (row) => row["id"] === "presentation-profile",
      ),
    ).toMatchObject({ name: "Previous Guest", trade: "Welder" });
  });

  it("lets only the Clerk owner load a resumable interview session", async () => {
    const sessionId = "33333333-3333-4333-8333-333333333333";
    fake.tables["interview_sessions"].push({
      id: sessionId,
      mentor_profile_id: "profile-a",
      contributor_user_id: USER_A,
      trade: "Welder",
      status: "active",
      current_question: "How do you prepare the joint?",
      question_count: 1,
      created_at: "2026-07-22T00:00:00.000Z",
    });
    fake.tables["interview_answers"] = [];

    const owner = await request(app)
      .get(`/api/interview/sessions/${sessionId}`)
      .set("x-test-user", USER_A);
    const other = await request(app)
      .get(`/api/interview/sessions/${sessionId}`)
      .set("x-test-user", USER_B);
    const presentation = await request(app)
      .get(`/api/interview/sessions/${sessionId}`)
      .set("x-test-user", "presentation-demo");

    expect(owner.status).toBe(200);
    expect(owner.body.session.id).toBe(sessionId);
    expect(other.status).toBe(404);
    expect(presentation.status).toBe(404);
  });

  it("exposes active-session discovery only to the interview owner", async () => {
    const profileId = "22222222-2222-4222-8222-222222222222";
    const sessionId = "44444444-4444-4444-8444-444444444444";
    fake.tables["mentor_profiles"].push({
      id: profileId,
      contributor_user_id: USER_A,
      name: "Tracy",
      trade: "Electrician",
      trade_input: "Electrical",
      created_at: "2026-07-22T00:00:00.000Z",
    });
    fake.tables["interview_sessions"].push({
      id: sessionId,
      mentor_profile_id: profileId,
      contributor_user_id: USER_A,
      trade: "Electrician",
      status: "active",
      current_question: "How do you test amperage safely?",
      question_count: 1,
      created_at: "2026-07-22T00:00:00.000Z",
    });

    const owner = await request(app)
      .get(`/api/interview/mentors/${profileId}/active-session`)
      .set("x-test-user", USER_A);
    const other = await request(app)
      .get(`/api/interview/mentors/${profileId}/active-session`)
      .set("x-test-user", USER_B);
    const presentation = await request(app)
      .get(`/api/interview/mentors/${profileId}/active-session`)
      .set("x-test-user", "presentation-demo");

    expect(owner.status).toBe(200);
    expect(owner.body.session.id).toBe(sessionId);
    expect(other.status).toBe(200);
    expect(other.body).toEqual({});
    expect(presentation.status).toBe(401);
  });
});
