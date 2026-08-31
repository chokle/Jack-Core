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
const REFRESHED_CONSENT_ID = "99999999-9999-4999-8999-999999999999";
const RECORDING_ID = "66666666-6666-4666-8666-666666666666";
const FEEDBACK_ID = "77777777-7777-4777-8777-777777777777";
const FAILURE_ID = "88888888-8888-4888-8888-888888888888";
const INITIAL_LAST_ACTIVITY = "2026-08-24T19:00:00.000Z";

function withdrawConsentOnStateRead(readNumber: number): void {
  const row = fake.tables.telemetry_consents[0]!;
  let reads = 0;
  let state = "granted";
  Object.defineProperty(row, "state", {
    configurable: true,
    enumerable: true,
    get: () => {
      reads += 1;
      if (reads >= readNumber) state = "withdrawn";
      return state;
    },
    set: (value: unknown) => {
      state = String(value);
    },
  });
}

function appendGrantedConsentAfterFirstRead(): void {
  const row = fake.tables.telemetry_consents[0]!;
  let reads = 0;
  Object.defineProperty(row, "state", {
    configurable: true,
    enumerable: true,
    get: () => {
      reads += 1;
      if (reads === 1) {
        fake.tables.telemetry_consents.push({
          id: REFRESHED_CONSENT_ID,
          actor_user_id: "tester-1",
          organization_id: ORGANIZATION_ID,
          pilot_id: PILOT_ID,
          scope: "telemetry",
          state: "granted",
          privacy_notice_version: "jack-pilot-privacy-2026-07-25",
          consent_version: "jack-pilot-consent-2026-07-25",
          occurred_at: "2026-08-24T19:01:00.000Z",
        });
      }
      return "granted";
    },
  });
}

function withdrawSessionOnStatusRead(readNumber: number): void {
  const row = fake.tables.test_sessions[0]!;
  let reads = 0;
  let status = "active";
  Object.defineProperty(row, "status", {
    configurable: true,
    enumerable: true,
    get: () => {
      reads += 1;
      if (reads >= readNumber) status = "withdrawn";
      return status;
    },
    set: (value: unknown) => {
      status = String(value);
    },
  });
}

function seedWithdrawalDependents(): void {
  fake.tables.activity_ingest_failures = [
    {
      id: FAILURE_ID,
      actor_user_id: "tester-1",
      pilot_id: PILOT_ID,
      test_session_id: SESSION_ID,
    },
  ];
  fake.tables.test_recordings = [
    {
      id: RECORDING_ID,
      tester_user_id: "tester-1",
      pilot_id: PILOT_ID,
      test_session_id: SESSION_ID,
    },
  ];
  fake.tables.test_feedback = [
    {
      id: FEEDBACK_ID,
      tester_user_id: "tester-1",
      pilot_id: PILOT_ID,
      test_session_id: SESSION_ID,
      notification_status: "pending",
    },
  ];
}

function expectWithdrawalCompensation(): void {
  expect(fake.tables.test_sessions[0]).toMatchObject({
    status: "withdrawn",
    telemetry_status: "withdrawn",
    recording_status: "withdrawn",
    deletion_due_at: expect.any(String),
  });
  expect(fake.tables.test_events[0]).toMatchObject({
    metadata: {},
    correlation_id: null,
    request_id: null,
    redacted_at: expect.any(String),
    deletion_due_at: expect.any(String),
  });
  expect(fake.tables.activity_ingest_failures).toHaveLength(0);
  expect(fake.tables.test_recordings[0]).toMatchObject({
    deletion_due_at: expect.any(String),
  });
  expect(fake.tables.test_feedback[0]).toMatchObject({
    deletion_due_at: expect.any(String),
    notification_status: "failed",
    notification_last_error: "telemetry_consent_withdrawn",
    notification_next_attempt_at: null,
  });
}

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
      telemetry_status: "granted",
      telemetry_consent_id: CONSENT_ID,
      started_at: INITIAL_LAST_ACTIVITY,
      last_activity_at: INITIAL_LAST_ACTIVITY,
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
      occurred_at: INITIAL_LAST_ACTIVITY,
    },
  ];
  fake.tables.test_events = [];
  fake.tables.activity_ingest_failures = [];
  fake.tables.test_recordings = [];
  fake.tables.test_feedback = [];
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
      INITIAL_LAST_ACTIVITY,
    );
  });

  it("records passive coverage without treating it as semantic activity", async () => {
    const response = await request(app())
      .post("/api/testing/activity-heartbeat")
      .send({
        appSessionId: APP_SESSION_ID,
        visibility: "hidden",
        meaningfulActivity: false,
        deviceCategory: "desktop",
      });

    expect(response.status).toBe(201);
    expect(fake.tables.test_events).toHaveLength(1);
    expect(fake.tables.test_events[0]).toMatchObject({
      event_type: "activity_heartbeat",
      metadata: {
        visibility: "hidden",
        meaningful_activity: false,
      },
    });
    expect(fake.tables.test_sessions[0]?.last_activity_at).toBe(
      INITIAL_LAST_ACTIVITY,
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

  it("compensates when consent is withdrawn after the heartbeat insert", async () => {
    seedWithdrawalDependents();
    // latestConsent reads once before the insert and again immediately after it.
    // Flip the stored row on that second read to deterministically interleave
    // withdrawal between the pre-write authorization and post-write fence.
    withdrawConsentOnStateRead(2);

    const response = await request(app())
      .post("/api/testing/activity-heartbeat")
      .send({
        appSessionId: APP_SESSION_ID,
        visibility: "foreground",
        meaningfulActivity: true,
        deviceCategory: "desktop",
      });

    expect(response.status).toBe(412);
    expect(fake.tables.test_events).toHaveLength(1);
    expectWithdrawalCompensation();
    expect(fake.tables.test_sessions[0]?.last_activity_at).toBe(
      INITIAL_LAST_ACTIVITY,
    );
  });

  it("guards the activity projection and compensates a withdrawal at session update", async () => {
    seedWithdrawalDependents();
    // The initial query reads status to filter and clone the session. The third
    // read is the guarded UPDATE predicate, where withdrawal wins the race.
    withdrawSessionOnStatusRead(3);
    // Consent is current before and immediately after the insert, then reflects
    // withdrawal when the failed guarded projection triggers its exact recheck.
    withdrawConsentOnStateRead(3);

    const response = await request(app())
      .post("/api/testing/activity-heartbeat")
      .send({
        appSessionId: APP_SESSION_ID,
        visibility: "foreground",
        meaningfulActivity: true,
        deviceCategory: "desktop",
      });

    expect(response.status).toBe(412);
    expect(fake.tables.test_events).toHaveLength(1);
    expectWithdrawalCompensation();
    expect(fake.tables.test_sessions[0]?.last_activity_at).toBe(
      INITIAL_LAST_ACTIVITY,
    );
  });

  it("redacts only the rejected heartbeat after a still-granted consent refresh", async () => {
    seedWithdrawalDependents();
    // Consent history is append-only in production. Append a newer granted row
    // after the pre-write read so the post-write exact-id fence sees a refresh,
    // not a withdrawal.
    appendGrantedConsentAfterFirstRead();

    const response = await request(app())
      .post("/api/testing/activity-heartbeat")
      .send({
        appSessionId: APP_SESSION_ID,
        visibility: "foreground",
        meaningfulActivity: true,
        deviceCategory: "desktop",
      });

    expect(response.status).toBe(409);
    expect(fake.tables.test_events[0]).toMatchObject({
      metadata: {},
      redacted_at: expect.any(String),
      deletion_due_at: expect.any(String),
    });
    expect(fake.tables.test_sessions[0]).toMatchObject({
      status: "active",
      telemetry_status: "granted",
      deletion_due_at: undefined,
      last_activity_at: INITIAL_LAST_ACTIVITY,
    });
    expect(fake.tables.activity_ingest_failures).toHaveLength(1);
    expect(fake.tables.test_recordings[0]?.deletion_due_at).toBeUndefined();
    expect(fake.tables.test_feedback[0]).toMatchObject({
      notification_status: "pending",
      deletion_due_at: undefined,
    });
  });

  it("compensates withdrawal detected after a successful session projection", async () => {
    seedWithdrawalDependents();
    // Reads: pre-write granted, post-insert granted, final post-projection
    // withdrawn. This proves the final fence is required and effective.
    withdrawConsentOnStateRead(3);

    const response = await request(app())
      .post("/api/testing/activity-heartbeat")
      .send({
        appSessionId: APP_SESSION_ID,
        visibility: "foreground",
        meaningfulActivity: true,
        deviceCategory: "desktop",
      });

    expect(response.status).toBe(412);
    expectWithdrawalCompensation();
    expect(fake.tables.test_sessions[0]?.last_activity_at).not.toBe(
      INITIAL_LAST_ACTIVITY,
    );
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
