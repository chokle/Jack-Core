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
  const actual = await importOriginal<typeof import("../../lib/interview.js")>();
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
  aiInterviewLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
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
    expect(fake.tables["mentor_profiles"].find((row) => row["id"] === "profile-a")).toMatchObject({
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
});
