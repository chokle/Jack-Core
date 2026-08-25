import express, { type Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const identity = vi.hoisted(() => ({
  userId: "tester-1",
  email: "tester@example.test",
  name: "Taylor Tester",
  isAdmin: false,
  isPresentation: false,
  classification: "resolved",
}));

vi.mock("../../lib/supabase.js", async () => {
  const mocks = await import("../../lib/__tests__/mocks.js");
  return { supabase: { from: mocks.fake.from.bind(mocks.fake) } };
});
vi.mock("../../lib/admin-auth.js", () => ({
  resolveIdentity: vi.fn(async () => ({ ...identity })),
}));

import { fake, resetMocks } from "../../lib/__tests__/mocks.js";
import activityHeartbeatRouter from "../activity-heartbeat.js";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const PILOT_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const APP_SESSION_ID = "44444444-4444-4444-8444-444444444444";
const CONSENT_ID = "55555555-5555-4555-8555-555555555555";

function app(): Express {
  const value = express();
  value.use(express.json());
  value.use((req, _res, next) => {
    (req as unknown as { log: { error: ReturnType<typeof vi.fn> } }).log = {
      error: vi.fn(),
    };
    next();
  });
  value.use("/api", activityHeartbeatRouter);
  return value;
}

beforeEach(() => {
  resetMocks();
  Object.assign(identity, {
    userId: "tester-1",
    isAdmin: false,
    isPresentation: false,
    classification: "resolved",
  });
  fake.tables.test_sessions = [
    {
      id: SESSION_ID,
      actor_user_id: "tester-1",
      organization_id: ORGANIZATION_ID,
      pilot_id: PILOT_ID,
      app_session_id: APP_SESSION_ID,
      status: "active",
      started_at: "2026-08-24T19:00:00.000Z",
      last_activity_at: "2026-08-24T19:00:00.000Z",
    },
  ];
  fake.tables.telemetry_consents = [
    {
      id: CONSENT_ID,
      actor_user_id: "tester-1",
      organization_id: ORGANIZATION_ID,
      pilot_id: PILOT_ID,
      scope: "telemetry",
      state: "granted",
      privacy_notice_version: "jack-pilot-privacy-2026-07-25",
      consent_version: "jack-pilot-consent-2026-07-25",
      occurred_at: "2026-08-24T19:00:00.000Z",
    },
  ];
  fake.tables.test_events = [];
});

describe("pilot activity heartbeat", () => {
  it("records minimized activity with schema-compatible browser metadata", async () => {
    const response = await request(app())
      .post("/api/testing/activity-heartbeat")
      .set("User-Agent", "Mozilla/5.0 Chrome/126.0.0.0 Safari/537.36")
      .send({
        appSessionId: APP_SESSION_ID,
        visibility: "foreground",
        meaningfulActivity: true,
        deviceCategory: "mobile",
      });

    expect(response.status).toBe(201);
    expect(fake.tables.test_events).toHaveLength(1);
    expect(fake.tables.test_events[0]).toMatchObject({
      actor_user_id: "tester-1",
      organization_id: ORGANIZATION_ID,
      pilot_id: PILOT_ID,
      test_session_id: SESSION_ID,
      app_session_id: APP_SESSION_ID,
      event_type: "activity_heartbeat",
      browser_family: "Chrome",
      device_category: "mobile",
      consent_id: CONSENT_ID,
      metadata: {
        visibility: "foreground",
        meaningful_activity: true,
      },
    });
    expect(fake.tables.test_sessions[0]?.last_activity_at).not.toBe(
      "2026-08-24T19:00:00.000Z",
    );
  });

  it("rejects hidden heartbeats that claim meaningful activity", async () => {
    const response = await request(app())
      .post("/api/testing/activity-heartbeat")
      .send({
        appSessionId: APP_SESSION_ID,
        visibility: "hidden",
        meaningfulActivity: true,
        deviceCategory: "desktop",
      });

    expect(response.status).toBe(400);
    expect(fake.tables.test_events).toHaveLength(0);
  });

  it("fails closed when current telemetry consent is no longer granted", async () => {
    fake.tables.telemetry_consents[0]!.state = "withdrawn";
    const response = await request(app())
      .post("/api/testing/activity-heartbeat")
      .send({
        appSessionId: APP_SESSION_ID,
        visibility: "foreground",
        meaningfulActivity: false,
        deviceCategory: "desktop",
      });

    expect(response.status).toBe(412);
    expect(fake.tables.test_events).toHaveLength(0);
  });
});
