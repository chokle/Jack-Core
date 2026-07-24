import { beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express, type Request } from "express";
import request from "supertest";

vi.mock("../../lib/supabase.js", async () => {
  const mocks = await import("../../lib/__tests__/mocks.js");
  return {
    supabase: {
      from: mocks.fake.from.bind(mocks.fake),
      storage: { from: vi.fn() },
    },
  };
});
vi.mock("../../lib/rate-limit.js", () => ({
  userTestingLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../lib/feedback-notifications.js", () => ({
  queueFeedbackNotification: vi.fn(),
}));
vi.mock("../../lib/admin-auth.js", () => ({
  resolveIdentity: vi.fn(),
  getAdminReviewer: () => "Admin Reviewer",
  requireAdmin: (req: Request, res: express.Response, next: express.NextFunction) => {
    const user = req.headers["x-test-user"];
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (user !== "admin") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    req.admin = { userId: "admin", email: "admin@example.test", name: "Admin Reviewer" };
    next();
  },
}));

import testingRouter from "../testing.js";
import { fake, resetMocks } from "../../lib/__tests__/mocks.js";

const ONE = "11111111-1111-4111-8111-111111111111";
const TWO = "22222222-2222-4222-8222-222222222222";
const THREE = "33333333-3333-4333-8333-333333333333";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const noop = () => {};
    (req as unknown as { log: Record<string, () => void> }).log = {
      warn: noop,
      error: noop,
      info: noop,
      debug: noop,
    };
    next();
  });
  app.use("/api", testingRouter);
  return app;
}

const app = makeApp();

function row(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    tester_user_id: `user-${id.slice(0, 4)}`,
    tester_email: "tester@example.test",
    tester_name: "Taylor Tester",
    tester_profile_id: null,
    tester_trade: "Electrical",
    session_id: `session-${id.slice(0, 4)}`,
    features_used: ["ask_jack"],
    device_category: "desktop",
    trigger: "logout",
    goal: "Find a safe procedure",
    useful: "yes",
    shortfall: "Needed a clearer source",
    adoption_need: "More Canadian examples",
    additional: "Written feedback",
    app_version: "test",
    status: "new",
    admin_notes: null,
    reviewed_by: null,
    reviewed_at: null,
    notification_status: "pending",
    notification_attempts: 0,
    notification_last_error: null,
    notification_last_attempt_at: null,
    notification_next_attempt_at: null,
    notification_sent_at: null,
    created_at: "2026-07-22T12:00:00.000Z",
    updated_at: "2026-07-22T12:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  resetMocks();
  fake.tables["test_feedback"] = [
    row(ONE),
    row(TWO, {
      tester_name: "Morgan Mechanic",
      tester_trade: "Automotive",
      useful: "partly",
      status: "reviewed",
      created_at: "2026-07-20T12:00:00.000Z",
    }),
    row(THREE, {
      tester_name: "Casey Carpenter",
      tester_trade: "Carpentry",
      useful: "no",
      created_at: "2026-07-10T12:00:00.000Z",
    }),
  ];
});

describe("admin user-test feedback review API", () => {
  it("rejects unauthenticated and non-admin list access server-side", async () => {
    expect((await request(app).get("/api/testing/feedback")).status).toBe(401);
    expect(
      (await request(app).get("/api/testing/feedback").set("x-test-user", "tester")).status,
    ).toBe(403);
  });

  it("lists feedback for admins with a total new-feedback count", async () => {
    const response = await request(app)
      .get("/api/testing/feedback")
      .set("x-test-user", "admin");

    expect(response.status).toBe(200);
    expect(response.body.feedback).toHaveLength(3);
    expect(response.body.unreadCount).toBe(2);
    expect(response.body.trades).toEqual(["Automotive", "Carpentry", "Electrical"]);
  });

  it("filters by trade, status, response, and date", async () => {
    const response = await request(app)
      .get("/api/testing/feedback")
      .query({
        trade: "Electrical",
        status: "new",
        usefulness: "yes",
        dateFrom: "2026-07-21",
        dateTo: "2026-07-23",
      })
      .set("x-test-user", "admin");

    expect(response.status).toBe(200);
    expect(response.body.feedback.map((item: { id: string }) => item.id)).toEqual([ONE]);
  });

  it("returns an admin-only detail without unrelated session content", async () => {
    expect(
      (await request(app).get(`/api/testing/feedback/${ONE}`).set("x-test-user", "tester"))
        .status,
    ).toBe(403);

    const response = await request(app)
      .get(`/api/testing/feedback/${ONE}`)
      .set("x-test-user", "admin");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: ONE,
      testerName: "Taylor Tester",
      usefulness: "yes",
      additional: "Written feedback",
    });
    expect(response.body).not.toHaveProperty("interviewAnswers");
    expect(response.body).not.toHaveProperty("prompts");
  });

  it("updates status and admin notes and reduces the new count", async () => {
    const updated = await request(app)
      .patch(`/api/testing/feedback/${ONE}`)
      .set("x-test-user", "admin")
      .send({ status: "actioned", adminNotes: "Added to the pilot backlog." });

    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      status: "actioned",
      adminNotes: "Added to the pilot backlog.",
      reviewedBy: "Admin Reviewer",
    });

    const list = await request(app)
      .get("/api/testing/feedback")
      .set("x-test-user", "admin");
    expect(list.body.unreadCount).toBe(1);
  });
});
