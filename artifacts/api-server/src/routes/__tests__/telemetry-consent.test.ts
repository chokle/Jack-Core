import express, { type Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const identity = vi.hoisted(() => ({
  userId: "tester-1",
  email: "tester@example.test",
  name: "Tester",
  isAdmin: false,
  isPresentation: false,
  classification: "resolved",
}));

vi.mock("../../lib/supabase.js", async () => {
  const mocks = await import("../../lib/__tests__/mocks.js");
  return {
    supabase: {
      from: mocks.fake.from.bind(mocks.fake),
      rpc: mocks.fake.rpc.bind(mocks.fake),
    },
  };
});
vi.mock("../../lib/admin-auth.js", () => ({
  resolveIdentity: vi.fn(async () => ({ ...identity })),
}));

import { fake, resetMocks } from "../../lib/__tests__/mocks.js";
import {
  reconcileTelemetryWithdrawalJob,
  runTelemetryWithdrawalSweep,
} from "../../lib/telemetry-withdrawal.js";
import telemetryConsentRouter from "../telemetry-consent.js";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const PILOT_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const TELEMETRY_GRANT_ID = "77777777-7777-4777-8777-777777777777";
const SCREEN_GRANT_ID = "66666666-6666-4666-8666-666666666661";
const MICROPHONE_GRANT_ID = "66666666-6666-4666-8666-666666666662";

function app(): Express {
  const value = express();
  value.use(express.json());
  value.use((req, _res, next) => {
    (req as never as { log: { error: ReturnType<typeof vi.fn> } }).log = {
      error: vi.fn(),
    };
    next();
  });
  value.use("/api", telemetryConsentRouter);
  return value;
}

function grant(
  scope: "telemetry" | "screen" | "microphone",
  id: string,
  occurredAt = "2026-01-01T00:00:00.000Z",
) {
  return {
    id,
    actor_user_id: "tester-1",
    organization_id: ORGANIZATION_ID,
    pilot_id: PILOT_ID,
    scope,
    state: "granted",
    privacy_notice_version: "jack-pilot-privacy-2026-07-25",
    consent_version: "jack-pilot-consent-2026-07-25",
    retained_until: "2027-01-01T00:00:00.000Z",
    occurred_at: occurredAt,
    created_at: occurredAt,
  };
}

function activeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    actor_user_id: "tester-1",
    organization_id: ORGANIZATION_ID,
    pilot_id: PILOT_ID,
    status: "active",
    telemetry_status: "granted",
    telemetry_consent_id: TELEMETRY_GRANT_ID,
    screen_consent_id: SCREEN_GRANT_ID,
    microphone_consent_id: MICROPHONE_GRANT_ID,
    screen_consent_state: "granted",
    microphone_consent_state: "granted",
    recording_status: "recording",
    started_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  resetMocks();
  Object.assign(identity, {
    userId: "tester-1",
    isAdmin: false,
    isPresentation: false,
    classification: "resolved",
  });
  fake.tables.organizations = [{ id: ORGANIZATION_ID, name: "Org", status: "active" }];
  fake.tables.pilots = [{
    id: PILOT_ID,
    organization_id: ORGANIZATION_ID,
    name: "Pilot",
    status: "active",
  }];
  fake.tables.pilot_memberships = [{
    user_id: "tester-1",
    organization_id: ORGANIZATION_ID,
    pilot_id: PILOT_ID,
    role: "tester",
    active: true,
    valid_from: "2026-01-01T00:00:00.000Z",
    valid_until: null,
  }];
  fake.tables.telemetry_consents = [];
  fake.tables.telemetry_withdrawal_jobs = [];
  fake.tables.telemetry_account_deletion_fences = [];
  fake.tables.test_sessions = [];
  fake.tables.test_events = [];
  fake.tables.test_recordings = [];
  fake.tables.test_feedback = [];
  fake.tables.activity_ingest_failures = [];
});

describe("telemetry consent", () => {
  it("denies a server-designated presentation account before persisting consent", async () => {
    identity.userId = "clerk-presentation-account";
    identity.isPresentation = true;

    const response = await request(app())
      .post("/api/testing/telemetry/consents")
      .send({
        pilotId: PILOT_ID,
        telemetry: "granted",
        screen: "declined",
        microphone: "declined",
        privacyNoticeVersion: "jack-pilot-privacy-2026-07-25",
        consentVersion: "jack-pilot-consent-2026-07-25",
      });

    expect(response.status).toBe(403);
    expect(fake.tables.telemetry_consents).toHaveLength(0);

    const withdrawal = await request(app())
      .post("/api/testing/telemetry/withdraw")
      .send({ pilotId: PILOT_ID, scopes: ["telemetry"] });
    expect(withdrawal.status).toBe(403);
    expect(fake.tables.telemetry_consents).toHaveLength(0);

    const context = await request(app()).get(
      `/api/testing/telemetry/context?pilotId=${PILOT_ID}`,
    );
    expect(context.status).toBe(403);

    const exportResponse = await request(app()).get("/api/testing/telemetry/export");
    expect(exportResponse.status).toBe(403);
  });

  it("continues to deny the legacy presentation-demo identity", async () => {
    identity.userId = "presentation-demo";

    expect((await request(app()).get("/api/testing/telemetry/context")).status).toBe(403);
    expect((await request(app()).get("/api/testing/telemetry/export")).status).toBe(403);
  });

  it("fails closed when trusted identity resolution is unavailable", async () => {
    identity.classification = "unavailable";

    expect((await request(app()).get("/api/testing/telemetry/context")).status).toBe(503);
    expect(
      (
        await request(app())
          .post("/api/testing/telemetry/consents")
          .send({
            pilotId: PILOT_ID,
            telemetry: "granted",
            screen: "declined",
            microphone: "declined",
            privacyNoticeVersion: "jack-pilot-privacy-2026-07-25",
            consentVersion: "jack-pilot-consent-2026-07-25",
          })
      ).status,
    ).toBe(503);
    expect(
      (
        await request(app())
          .post("/api/testing/telemetry/withdraw")
          .send({ pilotId: PILOT_ID, scopes: ["telemetry"] })
      ).status,
    ).toBe(503);
    expect((await request(app()).get("/api/testing/telemetry/export")).status).toBe(503);
    expect(fake.tables.telemetry_consents).toHaveLength(0);
  });

  it("preserves an administrator's existing personal export access", async () => {
    identity.isAdmin = true;

    const response = await request(app()).get("/api/testing/telemetry/export");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      consents: [],
      sessions: [],
      events: [],
      recordings: [],
    });
  });

  it("only exposes an active session bound to the exact latest telemetry grant", async () => {
    const oldConsentId = "77777777-7777-4777-8777-777777777777";
    const currentConsentId = "88888888-8888-4888-8888-888888888888";
    fake.tables.telemetry_consents = [
      {
        id: oldConsentId,
        actor_user_id: "tester-1",
        organization_id: ORGANIZATION_ID,
        pilot_id: PILOT_ID,
        scope: "telemetry",
        state: "granted",
        privacy_notice_version: "jack-pilot-privacy-2026-07-25",
        consent_version: "jack-pilot-consent-2026-07-25",
        occurred_at: "2026-07-25T00:00:00.000Z",
      },
      {
        id: currentConsentId,
        actor_user_id: "tester-1",
        organization_id: ORGANIZATION_ID,
        pilot_id: PILOT_ID,
        scope: "telemetry",
        state: "granted",
        privacy_notice_version: "jack-pilot-privacy-2026-07-25",
        consent_version: "jack-pilot-consent-2026-07-25",
        occurred_at: "2026-07-26T00:00:00.000Z",
      },
    ];
    fake.tables.test_sessions = [{
      id: SESSION_ID,
      actor_user_id: "tester-1",
      organization_id: ORGANIZATION_ID,
      pilot_id: PILOT_ID,
      status: "active",
      telemetry_status: "granted",
      telemetry_consent_id: oldConsentId,
      started_at: "2026-07-25T00:00:00.000Z",
    }];

    const stale = await request(app()).get(
      `/api/testing/telemetry/context?pilotId=${PILOT_ID}`,
    );
    expect(stale.status).toBe(200);
    expect(stale.body.session).toBeNull();

    fake.tables.test_sessions[0]!.telemetry_consent_id = currentConsentId;
    const exact = await request(app()).get(
      `/api/testing/telemetry/context?pilotId=${PILOT_ID}`,
    );
    expect(exact.status).toBe(200);
    expect(exact.body.session).toMatchObject({
      id: SESSION_ID,
      status: "active",
      telemetryStatus: "granted",
    });

    fake.tables.test_sessions[0]!.telemetry_status = "withdrawn";
    const withdrawn = await request(app()).get(
      `/api/testing/telemetry/context?pilotId=${PILOT_ID}`,
    );
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.session).toBeNull();
  });

  it("persists an explicit decline without creating a pilot session", async () => {
    const response = await request(app())
      .post("/api/testing/telemetry/consents")
      .send({
        pilotId: PILOT_ID,
        telemetry: "declined",
        screen: "declined",
        microphone: "declined",
        privacyNoticeVersion: "jack-pilot-privacy-2026-07-25",
        consentVersion: "jack-pilot-consent-2026-07-25",
      });
    expect(response.status).toBe(201);
    expect(fake.tables.telemetry_consents).toHaveLength(3);
    expect(fake.tables.test_sessions).toHaveLength(0);
  });

  it("rejects microphone consent without screen consent", async () => {
    const response = await request(app())
      .post("/api/testing/telemetry/consents")
      .send({
        pilotId: PILOT_ID,
        telemetry: "granted",
        screen: "declined",
        microphone: "granted",
        privacyNoticeVersion: "jack-pilot-privacy-2026-07-25",
        consentVersion: "jack-pilot-consent-2026-07-25",
      });
    expect(response.status).toBe(400);
    expect(fake.tables.telemetry_consents).toHaveLength(0);
  });

  it("withdraws immediately, redacts events, and schedules deletion within 30 days", async () => {
    fake.tables.telemetry_consents = [
      grant("telemetry", TELEMETRY_GRANT_ID),
      grant("screen", SCREEN_GRANT_ID),
      grant("microphone", MICROPHONE_GRANT_ID),
    ];
    fake.tables.test_sessions = [activeSession()];
    fake.tables.test_events = [{
      event_id: "44444444-4444-4444-8444-444444444444",
      actor_user_id: "tester-1",
      organization_id: ORGANIZATION_ID,
      pilot_id: PILOT_ID,
      test_session_id: SESSION_ID,
      consent_id: TELEMETRY_GRANT_ID,
      metadata: { feature: "library" },
      correlation_id: "request-1",
      occurred_at: "2099-01-01T00:00:00.000Z",
      received_at: "2026-01-01T00:00:00.000Z",
    }];
    fake.tables.test_recordings = [{
      id: "55555555-5555-4555-8555-555555555555",
      tester_user_id: "tester-1",
      pilot_id: PILOT_ID,
      test_session_id: SESSION_ID,
      screen_consent_id: SCREEN_GRANT_ID,
      microphone_consent_id: MICROPHONE_GRANT_ID,
      created_at: "2026-01-01T00:00:00.000Z",
    }];
    fake.tables.test_feedback = [
      {
        id: "66666666-6666-4666-8666-666666666666",
        tester_user_id: "tester-1",
        organization_id: ORGANIZATION_ID,
        pilot_id: PILOT_ID,
        test_session_id: SESSION_ID,
        notification_status: "pending",
        created_at: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "99999999-9999-4999-8999-999999999999",
        tester_user_id: "tester-2",
        organization_id: ORGANIZATION_ID,
        pilot_id: PILOT_ID,
        test_session_id: SESSION_ID,
        notification_status: "pending",
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ];
    fake.tables.activity_ingest_failures = [{
      id: "88888888-8888-4888-8888-888888888881",
      actor_user_id: "tester-1",
      organization_id: ORGANIZATION_ID,
      pilot_id: PILOT_ID,
      test_session_id: null,
      created_at: "2026-01-01T00:00:00.000Z",
    }];
    fake.tables.activity_report_runs = [{
      id: "88888888-8888-4888-8888-888888888888",
      organization_id: ORGANIZATION_ID,
      pilot_id: PILOT_ID,
      report_type: "pilot_summary",
      aggregate_snapshot: { participants: 1 },
    }];

    const response = await request(app())
      .post("/api/testing/telemetry/withdraw")
      .send({ pilotId: PILOT_ID, scopes: ["telemetry"] });

    expect(response.status).toBe(200);
    expect(response.body.withdrawn).toEqual(
      expect.arrayContaining(["telemetry", "screen", "microphone"]),
    );
    expect(Date.parse(response.body.deletionDueAt) - Date.now()).toBeLessThanOrEqual(
      30 * 24 * 60 * 60 * 1000,
    );
    expect(fake.tables.test_sessions[0]).toMatchObject({
      status: "withdrawn",
      telemetry_status: "withdrawn",
      recording_status: "withdrawn",
    });
    expect(fake.tables.test_events[0]).toMatchObject({
      metadata: {},
      correlation_id: null,
      redacted_at: expect.any(String),
    });
    expect(Date.parse(String(fake.tables.telemetry_consents[0]?.retained_until))).toBeGreaterThan(
      Date.now() + 23 * 30 * 24 * 60 * 60 * 1000,
    );
    expect(fake.tables.test_recordings[0]).toMatchObject({
      deletion_due_at: expect.any(String),
    });
    expect(fake.tables.test_feedback[0]).toMatchObject({
      deletion_due_at: expect.any(String),
      notification_status: "failed",
      notification_last_error: "telemetry_consent_withdrawn",
      notification_next_attempt_at: null,
    });
    expect(fake.tables.test_feedback[1]).toMatchObject({
      tester_user_id: "tester-2",
      notification_status: "pending",
    });
    expect(fake.tables.test_feedback[1]?.deletion_due_at).toBeUndefined();
    expect(fake.tables.activity_ingest_failures).toHaveLength(0);
    expect(fake.tables.activity_report_runs).toHaveLength(1);
  });

  it("retries old-epoch cleanup without touching a later regrant epoch", async () => {
    fake.tables.telemetry_consents = [
      grant("telemetry", TELEMETRY_GRANT_ID),
      grant("screen", SCREEN_GRANT_ID),
      grant("microphone", MICROPHONE_GRANT_ID),
    ];
    fake.tables.test_sessions = [activeSession()];
    fake.tables.test_events = [{
      event_id: "44444444-4444-4444-8444-444444444444",
      actor_user_id: "tester-1",
      organization_id: ORGANIZATION_ID,
      pilot_id: PILOT_ID,
      test_session_id: SESSION_ID,
      consent_id: TELEMETRY_GRANT_ID,
      metadata: { feature: "ask_jack" },
      correlation_id: "request-before-withdrawal",
      occurred_at: "2099-01-01T00:00:00.000Z",
      received_at: "2026-01-01T00:00:00.000Z",
    }];
    fake.tables.test_recordings = [{
      id: "55555555-5555-4555-8555-555555555555",
      tester_user_id: "tester-1",
      organization_id: ORGANIZATION_ID,
      pilot_id: PILOT_ID,
      test_session_id: SESSION_ID,
      screen_consent_id: SCREEN_GRANT_ID,
      microphone_consent_id: MICROPHONE_GRANT_ID,
      created_at: "2026-01-01T00:00:00.000Z",
    }];
    fake.tables.test_feedback = [{
      id: "66666666-6666-4666-8666-666666666666",
      tester_user_id: "tester-1",
      organization_id: ORGANIZATION_ID,
      pilot_id: PILOT_ID,
      test_session_id: SESSION_ID,
      notification_status: "pending",
      created_at: "2026-01-01T00:00:00.000Z",
    }];
    fake.failNext("test_events", "update", {
      message: "deterministic post-consent cleanup failure",
    });

    const response = await request(app())
      .post("/api/testing/telemetry/withdraw")
      .send({ pilotId: PILOT_ID, scopes: ["telemetry"] });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      cleanupPending: true,
      withdrawalPending: false,
      withdrawalJobId: expect.any(String),
    });
    expect(fake.tables.test_sessions[0]).toMatchObject({
      status: "withdrawn",
      telemetry_status: "withdrawn",
    });
    expect(fake.tables.test_events[0]).toMatchObject({
      metadata: { feature: "ask_jack" },
    });

    const newTelemetryId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
    const newScreenId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
    const newMicId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
    fake.tables.telemetry_consents.push(
      grant("telemetry", newTelemetryId, "2099-01-01T00:00:00.000Z"),
      grant("screen", newScreenId, "2099-01-01T00:00:00.000Z"),
      grant("microphone", newMicId, "2099-01-01T00:00:00.000Z"),
    );
    const newSessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    fake.tables.test_sessions.push(activeSession({
      id: newSessionId,
      telemetry_consent_id: newTelemetryId,
      screen_consent_id: newScreenId,
      microphone_consent_id: newMicId,
      started_at: "2099-01-01T00:00:00.000Z",
    }));
    fake.tables.test_events.push({
      event_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      actor_user_id: "tester-1",
      organization_id: ORGANIZATION_ID,
      pilot_id: PILOT_ID,
      test_session_id: newSessionId,
      consent_id: newTelemetryId,
      metadata: { feature: "fresh_epoch" },
      correlation_id: "fresh",
      occurred_at: "2099-01-01T00:00:01.000Z",
      received_at: "2099-01-01T00:00:01.000Z",
    });
    fake.tables.test_recordings.push({
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      tester_user_id: "tester-1",
      organization_id: ORGANIZATION_ID,
      pilot_id: PILOT_ID,
      test_session_id: newSessionId,
      screen_consent_id: newScreenId,
      microphone_consent_id: newMicId,
      created_at: "2099-01-01T00:00:01.000Z",
    });
    fake.tables.test_feedback.push({
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      tester_user_id: "tester-1",
      organization_id: ORGANIZATION_ID,
      pilot_id: PILOT_ID,
      test_session_id: newSessionId,
      notification_status: "pending",
      created_at: "2099-01-01T00:00:01.000Z",
    });

    fake.tables.telemetry_withdrawal_jobs[0]!.next_attempt_at =
      "2020-01-01T00:00:00.000Z";
    const sweep = await runTelemetryWithdrawalSweep();

    expect(sweep).toEqual({ attempted: 1, completed: 1, pending: 0, expired: 0 });
    expect(fake.tables.test_events[0]).toMatchObject({
      metadata: {},
      correlation_id: null,
      redacted_at: expect.any(String),
    });
    expect(fake.tables.test_sessions[1]).toMatchObject({
      status: "active",
      telemetry_status: "granted",
      telemetry_consent_id: newTelemetryId,
    });
    expect(fake.tables.test_events[1]).toMatchObject({
      metadata: { feature: "fresh_epoch" },
      correlation_id: "fresh",
    });
    expect(fake.tables.test_recordings[1]?.deletion_due_at).toBeUndefined();
    expect(fake.tables.test_feedback[1]).toMatchObject({
      notification_status: "pending",
    });

    fake.tables.telemetry_withdrawal_jobs[0]!.retained_until =
      "2020-01-01T00:00:00.000Z";
    const retentionDisabledSweep = await runTelemetryWithdrawalSweep();
    expect(retentionDisabledSweep).toEqual({
      attempted: 0,
      completed: 0,
      pending: 0,
      expired: 0,
    });
    expect(fake.tables.telemetry_withdrawal_jobs).toHaveLength(1);
  });

  it("allows withdrawal from retained consent history after membership is inactive", async () => {
    fake.tables.pilot_memberships[0]!.active = false;
    fake.tables.telemetry_consents = [{
      id: "77777777-7777-4777-8777-777777777777",
      actor_user_id: "tester-1",
      organization_id: ORGANIZATION_ID,
      pilot_id: PILOT_ID,
      scope: "telemetry",
      state: "granted",
      retained_until: "2027-01-01T00:00:00.000Z",
      occurred_at: "2026-01-01T00:00:00.000Z",
    }];

    const context = await request(app()).get("/api/testing/telemetry/context");
    expect(context.status).toBe(200);
    expect(context.body).toMatchObject({
      enrolled: false,
      scope: null,
      privacyScopes: [
        {
          organizationId: ORGANIZATION_ID,
          pilotId: PILOT_ID,
          organizationName: "Org",
          pilotName: "Pilot",
          consents: {
            telemetry: { state: "granted" },
          },
        },
      ],
    });

    const response = await request(app())
      .post("/api/testing/telemetry/withdraw")
      .send({ pilotId: PILOT_ID, scopes: ["telemetry"] });

    expect(response.status).toBe(200);
    expect(fake.tables.telemetry_consents.at(-1)).toMatchObject({
      actor_user_id: "tester-1",
      organization_id: ORGANIZATION_ID,
      pilot_id: PILOT_ID,
      state: "withdrawn",
    });
  });

  it("uses consent-ID CAS for partial withdrawal and preserves a rebound scope", async () => {
    fake.tables.telemetry_consents = [
      grant("telemetry", TELEMETRY_GRANT_ID),
      grant("screen", SCREEN_GRANT_ID),
      grant("microphone", MICROPHONE_GRANT_ID),
    ];
    fake.tables.test_sessions = [activeSession()];
    fake.tables.test_recordings = [{
      id: "55555555-5555-4555-8555-555555555555",
      tester_user_id: "tester-1",
      organization_id: ORGANIZATION_ID,
      pilot_id: PILOT_ID,
      test_session_id: SESSION_ID,
      screen_consent_id: SCREEN_GRANT_ID,
      microphone_consent_id: MICROPHONE_GRANT_ID,
    }];
    fake.failNext("test_sessions", "update", {
      message: "pause partial cleanup before consent CAS",
    });

    const response = await request(app())
      .post("/api/testing/telemetry/withdraw")
      .send({ pilotId: PILOT_ID, scopes: ["screen", "microphone"] });
    expect(response.status).toBe(202);

    const reboundScreenId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
    fake.tables.telemetry_consents.push(
      grant("screen", reboundScreenId, "2099-01-01T00:00:00.000Z"),
    );
    Object.assign(fake.tables.test_sessions[0]!, {
      screen_consent_id: reboundScreenId,
      screen_consent_state: "granted",
      microphone_consent_state: "granted",
      recording_status: "recording",
    });
    fake.tables.telemetry_withdrawal_jobs[0]!.next_attempt_at =
      "2020-01-01T00:00:00.000Z";

    const sweep = await runTelemetryWithdrawalSweep();
    expect(sweep).toEqual({ attempted: 1, completed: 1, pending: 0, expired: 0 });
    expect(fake.tables.test_sessions[0]).toMatchObject({
      screen_consent_id: reboundScreenId,
      screen_consent_state: "granted",
      microphone_consent_state: "withdrawn",
      recording_status: "withdrawn",
    });
    expect(fake.tables.test_recordings[0]).toMatchObject({
      deletion_due_at: expect.any(String),
    });
  });

  it("reconciles an ambiguous atomic RPC response when both authority rows committed", async () => {
    fake.tables.telemetry_consents = [
      grant("telemetry", TELEMETRY_GRANT_ID),
      grant("screen", SCREEN_GRANT_ID),
      grant("microphone", MICROPHONE_GRANT_ID),
    ];
    fake.tables.test_sessions = [activeSession()];
    fake.failAfterNext("rpc:append_telemetry_withdrawal", "insert", {
      message: "transport failed after transaction commit",
    });

    const response = await request(app())
      .post("/api/testing/telemetry/withdraw")
      .send({ pilotId: PILOT_ID, scopes: ["telemetry"] });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      withdrawalPending: false,
      cleanupPending: false,
    });
    expect(fake.tables.telemetry_withdrawal_jobs[0]).toMatchObject({
      status: "completed",
    });
    expect(fake.tables.telemetry_consents.filter((row) => row["state"] === "withdrawn"))
      .toHaveLength(3);
  });

  it("returns an actionable failure when the atomic append rolls back", async () => {
    fake.tables.telemetry_consents = [grant("telemetry", TELEMETRY_GRANT_ID)];
    fake.failNext("rpc:append_telemetry_withdrawal", "insert", {
      message: "database unavailable before commit",
    });

    const response = await request(app())
      .post("/api/testing/telemetry/withdraw")
      .send({ pilotId: PILOT_ID, scopes: ["telemetry"] });

    expect(response.status).toBe(503);
    expect(response.body.error).toContain("could not be confirmed");
    expect(fake.tables.telemetry_withdrawal_jobs).toHaveLength(0);
    expect(fake.tables.telemetry_consents).toEqual([
      expect.objectContaining({ id: TELEMETRY_GRANT_ID, state: "granted" }),
    ]);
  });

  it("never treats a generic manifest read failure as proof of withdrawal authority", async () => {
    const withdrawalConsentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
    fake.tables.telemetry_consents = [{
      ...grant("telemetry", TELEMETRY_GRANT_ID),
    }, {
      id: withdrawalConsentId,
      actor_user_id: "tester-1",
      organization_id: ORGANIZATION_ID,
      pilot_id: PILOT_ID,
      scope: "telemetry",
      state: "withdrawn",
      occurred_at: "2026-02-01T00:00:00.000Z",
    }];
    fake.tables.telemetry_withdrawal_jobs = [{
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      actor_user_id: "tester-1",
      organization_id: ORGANIZATION_ID,
      pilot_id: PILOT_ID,
      scopes: ["telemetry"],
      consent_ids: [withdrawalConsentId],
      epoch_consent_ids: { telemetry: [TELEMETRY_GRANT_ID] },
      epoch_row_ids: {},
      withdrawn_at: "2026-02-01T00:00:00.000Z",
      consent_retained_until: "2028-02-01T00:00:00.000Z",
      deletion_due_at: "2026-03-01T00:00:00.000Z",
      status: "pending",
      attempts: 0,
      next_attempt_at: "2020-01-01T00:00:00.000Z",
      updated_at: "2026-02-01T00:00:00.000Z",
    }];
    fake.failNext("telemetry_consents", "select", {
      message: "manifest read transport failure",
    });

    const result = await reconcileTelemetryWithdrawalJob(
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    );

    expect(result).toMatchObject({
      status: "pending",
      manifestCommitted: false,
      error: "manifest read transport failure",
    });
    expect(fake.tables.telemetry_withdrawal_jobs[0]).toMatchObject({
      status: "retrying",
    });
  });

  it("ages a defensive uncommitted orphan to finite retention and purges it", async () => {
    fake.tables.telemetry_withdrawal_jobs = [{
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      actor_user_id: "tester-1",
      organization_id: ORGANIZATION_ID,
      pilot_id: PILOT_ID,
      scopes: ["microphone"],
      consent_ids: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1"],
      epoch_consent_ids: { microphone: [] },
      epoch_row_ids: {},
      withdrawn_at: "2020-01-01T00:00:00.000Z",
      consent_retained_until: "2022-01-01T00:00:00.000Z",
      deletion_due_at: "2020-02-01T00:00:00.000Z",
      status: "pending",
      attempts: 0,
      next_attempt_at: "2020-01-01T00:00:00.000Z",
      updated_at: "2020-01-01T00:00:00.000Z",
    }];

    const result = await reconcileTelemetryWithdrawalJob(
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    );
    expect(result).toEqual({ status: "skipped", manifestCommitted: false });
    expect(fake.tables.telemetry_withdrawal_jobs[0]).toMatchObject({
      status: "cancelled",
      retained_until: expect.any(String),
      last_error: "authoritative_withdrawal_manifest_absent",
    });

    fake.tables.telemetry_withdrawal_jobs[0]!.retained_until =
      "2020-01-01T00:00:00.000Z";
    expect(await runTelemetryWithdrawalSweep()).toEqual({
      attempted: 0,
      completed: 0,
      pending: 0,
      expired: 0,
    });
    expect(fake.tables.telemetry_withdrawal_jobs).toHaveLength(1);
  });

  it("rejects stale old-consent writes after withdrawal cleanup completes", async () => {
    fake.tables.telemetry_consents = [
      grant("telemetry", TELEMETRY_GRANT_ID),
      grant("screen", SCREEN_GRANT_ID),
      grant("microphone", MICROPHONE_GRANT_ID),
    ];
    fake.tables.test_sessions = [activeSession()];
    fake.tables.test_recordings = [{
      id: "55555555-5555-4555-8555-555555555555",
      tester_user_id: "tester-1",
      organization_id: ORGANIZATION_ID,
      pilot_id: PILOT_ID,
      test_session_id: SESSION_ID,
      screen_consent_id: SCREEN_GRANT_ID,
      microphone_consent_id: MICROPHONE_GRANT_ID,
    }];

    expect(
      (
        await request(app())
          .post("/api/testing/telemetry/withdraw")
          .send({ pilotId: PILOT_ID, scopes: ["telemetry"] })
      ).status,
    ).toBe(200);

    const staleEvent = await fake.from("test_events").insert({
      event_id: "44444444-4444-4444-8444-444444444444",
      actor_user_id: "tester-1",
      organization_id: ORGANIZATION_ID,
      pilot_id: PILOT_ID,
      test_session_id: SESSION_ID,
      consent_id: TELEMETRY_GRANT_ID,
      metadata: { late: true },
    });
    expect(staleEvent.error?.message).toContain("not current");
    expect(fake.tables.test_events).toHaveLength(0);

    const staleRecordingFinalize = await fake
      .from("test_recordings")
      .update({ deletion_due_at: null, status: "uploaded" })
      .eq("id", "55555555-5555-4555-8555-555555555555");
    expect(staleRecordingFinalize.error?.message).toContain("not current");
    expect(fake.tables.test_recordings[0]?.deletion_due_at).toEqual(expect.any(String));

    const staleFeedback = await fake.from("test_feedback").insert({
      id: "66666666-6666-4666-8666-666666666666",
      tester_user_id: "tester-1",
      organization_id: ORGANIZATION_ID,
      pilot_id: PILOT_ID,
      test_session_id: SESSION_ID,
      deletion_due_at: null,
    });
    expect(staleFeedback.error?.message).toContain("not current");

    const staleFailure = await fake.from("activity_ingest_failures").insert({
      id: "88888888-8888-4888-8888-888888888888",
      actor_user_id: "tester-1",
      organization_id: ORGANIZATION_ID,
      pilot_id: PILOT_ID,
      test_session_id: null,
    });
    expect(staleFailure.error?.message).toContain("not current");
  });

  it("serializes account deletion before and after withdrawal writes", async () => {
    fake.tables.telemetry_consents = [grant("telemetry", TELEMETRY_GRANT_ID)];
    const committed = await fake.rpc("append_telemetry_withdrawal", {
      p_job_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      p_actor_user_id: "tester-1",
      p_organization_id: ORGANIZATION_ID,
      p_pilot_id: PILOT_ID,
      p_scopes: ["microphone"],
      p_consent_ids: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1"],
      p_consent_retained_until: "2028-01-01T00:00:00.000Z",
      p_deletion_due_at: "2026-02-01T00:00:00.000Z",
      p_privacy_notice_version: "notice",
      p_consent_version: "consent",
    });
    expect(committed.error).toBeNull();
    expect(fake.tables.telemetry_withdrawal_jobs).toHaveLength(1);

    expect(
      (
        await fake.rpc("begin_telemetry_account_deletion", {
          p_actor_user_id: "tester-1",
        })
      ).error,
    ).toBeNull();
    expect(fake.tables.telemetry_withdrawal_jobs).toHaveLength(0);
    expect(fake.tables.telemetry_account_deletion_fences[0]?.actor_hash).not.toContain(
      "tester-1",
    );

    const consentAfterFence = await fake.from("telemetry_consents").insert(
      grant("telemetry", "cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
    );
    expect(consentAfterFence.error?.message).toContain("deletion is already in progress");
    const jobAfterFence = await fake.rpc("append_telemetry_withdrawal", {
      p_job_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      p_actor_user_id: "tester-1",
      p_organization_id: ORGANIZATION_ID,
      p_pilot_id: PILOT_ID,
      p_scopes: ["microphone"],
      p_consent_ids: ["eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"],
      p_consent_retained_until: "2028-01-01T00:00:00.000Z",
      p_deletion_due_at: "2026-02-01T00:00:00.000Z",
      p_privacy_notice_version: "notice",
      p_consent_version: "consent",
    });
    expect(jobAfterFence.error?.message).toContain("deletion is already in progress");

    expect(
      (
        await fake.rpc("finish_telemetry_account_deletion", {
          p_actor_user_id: "tester-1",
        })
      ).error,
    ).toBeNull();
    expect(fake.tables.telemetry_consents).toHaveLength(0);
    expect(
      (
        await fake.rpc("begin_telemetry_account_deletion", {
          p_actor_user_id: "tester-1",
        })
      ).error,
    ).toBeNull();
  });

  it("preserves a promoted administrator's owned history rights without enabling collection", async () => {
    identity.isAdmin = true;
    fake.tables.pilot_memberships[0]!.active = false;
    fake.tables.telemetry_consents = [grant("telemetry", TELEMETRY_GRANT_ID)];

    const context = await request(app()).get("/api/testing/telemetry/context");
    expect(context.status).toBe(200);
    expect(context.body).toMatchObject({
      enrolled: false,
      scope: null,
      privacyScopes: [
        {
          pilotId: PILOT_ID,
          consents: { telemetry: { state: "granted" } },
        },
      ],
    });

    const newConsent = await request(app())
      .post("/api/testing/telemetry/consents")
      .send({
        pilotId: PILOT_ID,
        telemetry: "granted",
        screen: "declined",
        microphone: "declined",
        privacyNoticeVersion: "jack-pilot-privacy-2026-07-25",
        consentVersion: "jack-pilot-consent-2026-07-25",
      });
    expect(newConsent.status).toBe(403);

    const withdrawal = await request(app())
      .post("/api/testing/telemetry/withdraw")
      .send({ pilotId: PILOT_ID, scopes: ["telemetry"] });
    expect(withdrawal.status).toBe(200);

    fake.tables.telemetry_withdrawal_jobs[0]!.lease_token = "internal";
    fake.tables.telemetry_withdrawal_jobs[0]!.last_error = "internal";
    const exported = await request(app()).get("/api/testing/telemetry/export");
    expect(exported.status).toBe(200);
    expect(exported.body.withdrawalJobs).toEqual([
      expect.objectContaining({
        id: fake.tables.telemetry_withdrawal_jobs[0]!.id,
        pilotId: PILOT_ID,
        status: "completed",
      }),
    ]);
    expect(exported.body.withdrawalJobs[0]).not.toHaveProperty("leaseToken");
    expect(exported.body.withdrawalJobs[0]).not.toHaveProperty("lastError");
    expect(exported.body.withdrawalJobs[0]).not.toHaveProperty("consentIds");
  });

});
