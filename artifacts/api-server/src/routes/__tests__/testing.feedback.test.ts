import { beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

const resolveIdentity = vi.hoisted(() => vi.fn());
const from = vi.hoisted(() => vi.fn());
const queueFeedbackNotification = vi.hoisted(() => vi.fn());

vi.mock("../../lib/admin-auth.js", () => ({
  resolveIdentity,
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
  getAdminReviewer: () => "Admin",
}));
vi.mock("../../lib/supabase.js", () => ({
  supabase: { from, storage: { from: vi.fn() } },
}));
vi.mock("../../lib/feedback-notifications.js", () => ({ queueFeedbackNotification }));
vi.mock("../../lib/rate-limit.js", () => ({
  userTestingLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import testingRouter from "../testing.js";

const validBody = {
  feedbackId: "11111111-1111-4111-8111-111111111111",
  goal: "Find a safe procedure",
  useful: "partly",
  shortfall: "Needed clearer sourcing",
  adoptionNeed: "More local examples",
  additional: null,
  featuresUsed: ["ask_jack"],
  sessionId: "session-1",
  deviceCategory: "desktop",
  trigger: "logout",
  appVersion: "abc123",
};

function app(): Express {
  const value = express();
  value.use(express.json());
  value.use((req, _res, next) => {
    req.userId = "user_1";
    (req as never as { log: { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> } }).log = {
      error: vi.fn(),
      warn: vi.fn(),
    };
    next();
  });
  value.use("/api", testingRouter);
  return value;
}

beforeEach(() => {
  resolveIdentity.mockReset();
  from.mockReset();
  queueFeedbackNotification.mockReset();
  resolveIdentity.mockResolvedValue({
    userId: "user_1",
    email: "tester@example.com",
    name: "Tester",
    isAdmin: false,
  });
  from.mockImplementation((table: string) => {
    if (table === "mentor_profiles") {
      return {
        select: () => ({
          eq: () => ({
            order: () => ({
              limit: () => ({
                maybeSingle: async () => ({
                  data: { id: "22222222-2222-4222-8222-222222222222", trade: "Electrical" },
                  error: null,
                }),
              }),
            }),
          }),
        }),
      };
    }
    return {
      insert: (payload: unknown) => ({
        select: () => ({
          single: async () => ({
            data: { id: validBody.feedbackId, created_at: "2026-07-23T00:00:00Z", payload },
            error: null,
          }),
        }),
      }),
    };
  });
});
describe("POST /api/testing/feedback", () => {
  it("stores allowlisted feedback with server-resolved tester context", async () => {
    const response = await request(app()).post("/api/testing/feedback").send(validBody);
    expect(response.status).toBe(201);
    expect(response.body.id).toBe(validBody.feedbackId);
    expect(from).toHaveBeenCalledWith("mentor_profiles");
    expect(from).toHaveBeenCalledWith("test_feedback");
    expect(queueFeedbackNotification).toHaveBeenCalledWith(validBody.feedbackId);
  });

  it("returns persisted feedback even if notification enqueueing fails", async () => {
    queueFeedbackNotification.mockImplementationOnce(() => {
      throw new Error("notification unavailable");
    });

    const response = await request(app()).post("/api/testing/feedback").send(validBody);

    expect(response.status).toBe(201);
    expect(response.body.id).toBe(validBody.feedbackId);
    expect(from).toHaveBeenCalledWith("test_feedback");
  });

  it("treats a retried feedback id as the same authoritative record", async () => {
    let feedbackCalls = 0;
    from.mockImplementation((table: string) => {
      if (table === "mentor_profiles") {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: async () => ({ data: null, error: null }),
                }),
              }),
            }),
          }),
        };
      }
      feedbackCalls += 1;
      if (feedbackCalls === 1) {
        return {
          insert: () => ({
            select: () => ({
              single: async () => ({
                data: null,
                error: { code: "23505", message: "duplicate key" },
              }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  id: validBody.feedbackId,
                  created_at: "2026-07-23T00:00:00Z",
                },
                error: null,
              }),
            }),
          }),
        }),
      };
    });

    const response = await request(app()).post("/api/testing/feedback").send(validBody);

    expect(response.status).toBe(200);
    expect(response.body.id).toBe(validBody.feedbackId);
    expect(queueFeedbackNotification).toHaveBeenCalledOnce();
  });

  it("rejects public presentation visitors", async () => {
    resolveIdentity.mockResolvedValue(null);
    const response = await request(app()).post("/api/testing/feedback").send(validBody);
    expect(response.status).toBe(403);
    expect(from).not.toHaveBeenCalled();
  });

  it("rejects presentation-demo with 403, without writing feedback or queueing notification", async () => {
    resolveIdentity.mockResolvedValue({
      userId: "presentation-demo",
      email: "presentation-demo@test.local",
      name: "Presentation Demo",
      isAdmin: false,
    });

    const response = await request(app()).post("/api/testing/feedback").send(validBody);

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: "User-testing feedback is unavailable in presentation mode.",
    });
    expect(from).not.toHaveBeenCalled();
    expect(queueFeedbackNotification).not.toHaveBeenCalled();
  });

  it.each([
    { ...validBody, featuresUsed: [] },
    { ...validBody, featuresUsed: ["private_prompt"] },
    { ...validBody, trigger: "side_exit" },
    { ...validBody, useful: "maybe" },
    { ...validBody, goal: "" },
    { ...validBody, testerUserId: "spoofed" },
  ])("rejects invalid or privacy-expanding payloads", async (body) => {
    const response = await request(app()).post("/api/testing/feedback").send(body);
    expect(response.status).toBe(400);
    expect(from).not.toHaveBeenCalled();
  });
});
