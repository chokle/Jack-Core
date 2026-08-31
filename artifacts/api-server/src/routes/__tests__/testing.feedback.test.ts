import { beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

const resolveIdentity = vi.hoisted(() => vi.fn());
const from = vi.hoisted(() => vi.fn());
const storageFrom = vi.hoisted(() => vi.fn());
const queueFeedbackNotification = vi.hoisted(() => vi.fn());
const testSessionEq = vi.fn();

vi.mock("../../lib/admin-auth.js", () => ({
  resolveIdentity,
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
  getAdminReviewer: () => "Admin",
}));
vi.mock("../../lib/supabase.js", () => ({
  supabase: { from, storage: { from: storageFrom } },
}));
vi.mock("../../lib/feedback-notifications.js", () => ({ queueFeedbackNotification }));
vi.mock("../../lib/rate-limit.js", () => ({
  userTestingLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import testingRouter from "../testing.js";

const ORGANIZATION_ID = "44444444-4444-4444-8444-444444444444";
const PILOT_ID = "55555555-5555-4555-8555-555555555555";
const validBody = {
  feedbackId: "11111111-1111-4111-8111-111111111111",
  goal: "Find a safe procedure",
  useful: "partly",
  shortfall: "Needed clearer sourcing",
  adoptionNeed: "More local examples",
  additional: null,
  featuresUsed: ["ask_jack"],
  sessionId: "33333333-3333-4333-8333-333333333333",
  pilotId: PILOT_ID,
  deviceCategory: "desktop",
  trigger: "logout",
  appVersion: "abc123",
};

function scopeQuery(table: string): Record<string, unknown> | null {
  if (table === "pilot_memberships") {
    const query = {
      select: () => query,
      eq: () => query,
      limit: async () => ({
        data: [{
          organization_id: ORGANIZATION_ID,
          pilot_id: PILOT_ID,
          user_id: "user_1",
          role: "tester",
          active: true,
          valid_from: "2026-01-01T00:00:00.000Z",
          valid_until: null,
        }],
        error: null,
      }),
    };
    return query;
  }
  if (table === "pilots") {
    const query = {
      select: () => query,
      eq: () => query,
      maybeSingle: async () => ({
        data: {
          id: PILOT_ID,
          organization_id: ORGANIZATION_ID,
          status: "active",
          name: "Pilot",
        },
        error: null,
      }),
    };
    return query;
  }
  return null;
}

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
  storageFrom.mockReset();
  queueFeedbackNotification.mockReset();
  testSessionEq.mockReset();
  resolveIdentity.mockResolvedValue({
    userId: "user_1",
    email: "tester@example.com",
    name: "Tester",
    isAdmin: false,
    isPresentation: false,
    classification: "resolved",
  });
  const testSessionQuery = {
    select: () => testSessionQuery,
    eq: testSessionEq.mockImplementation(() => testSessionQuery),
    maybeSingle: async () => ({
      data: {
        id: validBody.sessionId,
        organization_id: ORGANIZATION_ID,
        pilot_id: PILOT_ID,
      },
      error: null,
    }),
  };
  from.mockImplementation((table: string) => {
    const scoped = scopeQuery(table);
    if (scoped) return scoped;
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
    if (table === "test_sessions") return testSessionQuery;
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
    expect(testSessionEq).toHaveBeenCalledWith("id", validBody.sessionId);
    expect(testSessionEq).toHaveBeenCalledWith("actor_user_id", "user_1");
    expect(testSessionEq).toHaveBeenCalledWith("organization_id", ORGANIZATION_ID);
    expect(testSessionEq).toHaveBeenCalledWith("pilot_id", PILOT_ID);
    expect(testSessionEq).toHaveBeenCalledWith("status", "active");
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

  it("rejects feedback without an active owned telemetry session", async () => {
    const defaultImplementation = from.getMockImplementation();
    from.mockImplementation((table: string) => {
      if (table === "test_sessions") {
        const query = {
          select: () => query,
          eq: () => query,
          maybeSingle: async () => ({ data: null, error: null }),
        };
        return query;
      }
      return defaultImplementation!(table);
    });

    const response = await request(app()).post("/api/testing/feedback").send(validBody);

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: "An active owned pilot session is required to submit feedback.",
    });
    expect(from).not.toHaveBeenCalledWith("test_feedback");
    expect(queueFeedbackNotification).not.toHaveBeenCalled();
  });

  it("treats a retried feedback id as the same authoritative record", async () => {
    let feedbackCalls = 0;
    const testSessionQuery = {
      select: () => testSessionQuery,
      eq: () => testSessionQuery,
      maybeSingle: async () => ({
        data: {
          id: validBody.sessionId,
          organization_id: ORGANIZATION_ID,
          pilot_id: PILOT_ID,
        },
        error: null,
      }),
    };
    from.mockImplementation((table: string) => {
      const scoped = scopeQuery(table);
      if (scoped) return scoped;
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
      if (table === "test_sessions") return testSessionQuery;
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
      userId: "clerk-presentation-account",
      email: "presentation-demo@test.local",
      name: "Presentation Demo",
      isAdmin: false,
      isPresentation: true,
      classification: "restricted",
    });

    const response = await request(app()).post("/api/testing/feedback").send(validBody);

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: "User-testing feedback is unavailable in presentation mode.",
    });
    expect(from).not.toHaveBeenCalled();
    expect(queueFeedbackNotification).not.toHaveBeenCalled();
  });

  it("fails closed when trusted identity resolution is unavailable", async () => {
    resolveIdentity.mockResolvedValue({
      userId: "user_1",
      email: null,
      name: null,
      isAdmin: false,
      isPresentation: false,
      classification: "unavailable",
    });

    const feedback = await request(app()).post("/api/testing/feedback").send(validBody);
    expect(feedback.status).toBe(503);
    expect(from).not.toHaveBeenCalled();

    const recording = await request(app())
      .post("/api/testing/recordings")
      .field("sessionId", validBody.sessionId)
      .attach("file", Buffer.from("test recording"), {
        filename: "test.webm",
        contentType: "video/webm",
      });
    expect(recording.status).toBe(503);
    expect(from).not.toHaveBeenCalled();
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


describe("POST /api/testing/recordings consent races", () => {
  it.each(["telemetry", "screen"] as const)(
    "removes and schedules a recording inserted after %s withdrawal",
    async (withdrawnScope) => {
      const telemetryConsentId = "66666666-6666-4666-8666-666666666666";
      const screenConsentId = "77777777-7777-4777-8777-777777777777";
      let recordingId = "";
      let withdrawalCompleted = false;
      let recordingInsert: Record<string, unknown> | null = null;
      let recordingUpdate: Record<string, unknown> | null = null;
      const uploadRecording = vi.fn(async () => ({ data: null, error: null }));
      const removeRecording = vi.fn(async () => ({ data: null, error: null }));
      storageFrom.mockReturnValue({
        upload: uploadRecording,
        remove: removeRecording,
      });

      const completedQuery = () => {
        const query = {
          eq: () => query,
          then: (
            onfulfilled?: (result: { data: null; error: null }) => unknown,
            onrejected?: (reason: unknown) => unknown,
          ) =>
            Promise.resolve({ data: null, error: null }).then(onfulfilled, onrejected),
        };
        return query;
      };

      from.mockImplementation((table: string) => {
        if (table === "test_sessions") {
          const query = {
            select: () => query,
            eq: () => query,
            maybeSingle: async () => ({
              data: {
                id: validBody.sessionId,
                organization_id: ORGANIZATION_ID,
                pilot_id: PILOT_ID,
                telemetry_consent_id: telemetryConsentId,
                screen_consent_id: screenConsentId,
                microphone_consent_id: null,
              },
              error: null,
            }),
          };
          return query;
        }
        if (table === "telemetry_consents") {
          let requestedScope = "";
          const query = {
            select: () => query,
            eq: (column: string, value: unknown) => {
              if (column === "scope") requestedScope = String(value);
              return query;
            },
            order: () => query,
            limit: () => query,
            maybeSingle: async () => {
              const consentId =
                requestedScope === "telemetry" ? telemetryConsentId : screenConsentId;
              return {
                data: {
                  id: consentId,
                  state:
                    withdrawalCompleted && requestedScope === withdrawnScope
                      ? "withdrawn"
                      : "granted",
                  privacy_notice_version: "jack-pilot-privacy-2026-07-25",
                  consent_version: "jack-pilot-consent-2026-07-25",
                  occurred_at: withdrawalCompleted
                    ? "2026-07-26T00:00:00.000Z"
                    : "2026-07-25T00:00:00.000Z",
                },
                error: null,
              };
            },
          };
          return query;
        }
        if (table === "test_recordings") {
          return {
            insert: (payload: Record<string, unknown>) => ({
              select: () => ({
                single: async () => {
                  recordingInsert = payload;
                  recordingId = String(payload["id"]);
                  withdrawalCompleted = true;
                  return {
                    data: { id: recordingId, created_at: "2026-07-26T00:00:00.000Z" },
                    error: null,
                  };
                },
              }),
            }),
            update: (payload: Record<string, unknown>) => {
              recordingUpdate = payload;
              return completedQuery();
            },
            delete: () => completedQuery(),
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      });

      const response = await request(app())
        .post("/api/testing/recordings")
        .field("sessionId", validBody.sessionId)
        .attach("file", Buffer.from("controlled race recording"), {
          filename: "race.webm",
          contentType: "video/webm",
        });

      expect(response.status).toBe(412);
      expect(response.body.error).toContain("Recording consent changed");
      expect(recordingInsert).toMatchObject({
        id: expect.any(String),
        tester_user_id: "user_1",
        test_session_id: validBody.sessionId,
        screen_consent_id: screenConsentId,
      });
      expect(recordingUpdate).toMatchObject({
        deletion_due_at: expect.any(String),
      });
      expect(uploadRecording).toHaveBeenCalledOnce();
      expect(removeRecording).toHaveBeenCalledOnce();
      expect(removeRecording.mock.calls[0]?.[0]).toEqual([
        expect.stringMatching(new RegExp(`^recordings/${recordingId}/race\\.webm$`)),
      ]);
    },
  );
});
