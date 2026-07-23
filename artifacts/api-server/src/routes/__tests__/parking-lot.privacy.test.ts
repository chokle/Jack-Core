import { beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express, type Request } from "express";
import request from "supertest";

vi.mock("../../lib/supabase.js", async () => {
  const mocks = await import("../../lib/__tests__/mocks.js");
  return { supabase: mocks.fake };
});

vi.mock("../../lib/rate-limit.js", () => ({
  parkingLotLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import parkingLotRouter from "../parking-lot.js";
import { fake, resetMocks } from "../../lib/__tests__/mocks.js";
import { PRESENTATION_USER_ID } from "../../middlewares/resolveApiIdentity.js";

const OWNER = "user_owner";
const OTHER = "user_other";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const THOUGHT_ID = "22222222-2222-4222-8222-222222222222";

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
    const user = req.header("x-test-user");
    if (user) req.userId = user;
    next();
  });
  app.use("/api", parkingLotRouter);
  return app;
}

const app = makeApp();

beforeEach(() => {
  resetMocks();
  fake.tables["interview_sessions"] = [
    {
      id: SESSION_ID,
      contributor_user_id: OWNER,
      mentor_profile_id: "mentor-owner",
    },
  ];
  fake.tables["parked_thoughts"] = [
    {
      id: THOUGHT_ID,
      source: "interview",
      interview_session_id: SESSION_ID,
      mentor_profile_id: "mentor-owner",
      mentor_name: "Tracy",
      title: "meter testing",
      summary: "Private interview bookmark",
      status: "parked",
      context_snapshot: [],
      created_at: "2026-07-22T00:00:00.000Z",
    },
  ];
});

describe("parked interview ownership", () => {
  it("lists the interview bookmark for its Clerk owner with manage permission", async () => {
    const response = await request(app)
      .get("/api/parking-lot?status=parked")
      .set("x-test-user", OWNER);

    expect(response.status).toBe(200);
    expect(response.body.items).toEqual([
      expect.objectContaining({
        id: THOUGHT_ID,
        canManage: true,
      }),
    ]);
  });

  it.each([OTHER, PRESENTATION_USER_ID])(
    "does not disclose an interview bookmark to %s",
    async (userId) => {
      const response = await request(app)
        .get("/api/parking-lot?status=parked")
        .set("x-test-user", userId);

      expect(response.status).toBe(200);
      expect(response.body.items).toEqual([]);
    },
  );

  it.each([OTHER, PRESENTATION_USER_ID])(
    "returns the same 404 for cross-user resume by %s",
    async (userId) => {
      const response = await request(app)
        .post(`/api/parking-lot/${THOUGHT_ID}/resume`)
        .set("x-test-user", userId);

      expect(response.status).toBe(404);
      expect(response.body.error).toContain("not found");
      expect(fake.tables["parked_thoughts"][0]?.["status"]).toBe("parked");
    },
  );

  it.each([OTHER, PRESENTATION_USER_ID])(
    "returns the same 404 for cross-user archive by %s",
    async (userId) => {
      const response = await request(app)
        .post(`/api/parking-lot/${THOUGHT_ID}/archive`)
        .set("x-test-user", userId);

      expect(response.status).toBe(404);
      expect(fake.tables["parked_thoughts"][0]?.["status"]).toBe("parked");
    },
  );

  it("allows the owner to resume the bookmark", async () => {
    const response = await request(app)
      .post(`/api/parking-lot/${THOUGHT_ID}/resume`)
      .set("x-test-user", OWNER);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: THOUGHT_ID,
      status: "resumed",
      canManage: true,
    });
  });

  it("does not let presentation mode create an owned interview bookmark", async () => {
    const response = await request(app)
      .post("/api/parking-lot")
      .set("x-test-user", PRESENTATION_USER_ID)
      .send({
        source: "interview",
        interviewSessionId: SESSION_ID,
        context: [],
      });

    expect(response.status).toBe(401);
    expect(fake.tables["parked_thoughts"]).toHaveLength(1);
  });
});
