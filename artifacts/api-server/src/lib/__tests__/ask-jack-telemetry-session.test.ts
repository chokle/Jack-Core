import type { Request } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CallerIdentity } from "../admin-auth.js";

vi.mock("../supabase.js", async () => {
  const mocks = await import("./mocks.js");
  return { supabase: { from: (table: string) => mocks.fake.from(table) } };
});

import { fake, resetMocks } from "./mocks.js";
import {
  CONSENT_VERSION,
  PRIVACY_NOTICE_VERSION,
  recordServerAskJackEvent,
} from "../activity-telemetry.js";
import { ensureAskJackTelemetrySession } from "../ask-jack-telemetry-session.js";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const PILOT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_PILOT_ID = "33333333-3333-4333-8333-333333333333";
const CONSENT_ID = "88888888-8888-4888-8888-888888888888";

function request(): Request {
  return {
    method: "POST",
    path: "/chat",
    headers: {
      "user-agent": "Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
      "x-request-id": "request-1",
    },
    log: { warn: vi.fn() },
  } as unknown as Request;
}

function identity(overrides: Partial<CallerIdentity> = {}): CallerIdentity {
  return {
    userId: "tester-1",
    email: "tester@example.test",
    name: "Tester",
    isAdmin: false,
    isPresentation: false,
    classification: "resolved",
    ...overrides,
  };
}

function grantTelemetry(userId = "tester-1", pilotId = PILOT_ID) {
  fake.tables.telemetry_consents.push({
    id: CONSENT_ID,
    actor_user_id: userId,
    organization_id: ORGANIZATION_ID,
    pilot_id: pilotId,
    scope: "telemetry",
    state: "granted",
    privacy_notice_version: PRIVACY_NOTICE_VERSION,
    consent_version: CONSENT_VERSION,
    occurred_at: "2026-09-03T20:00:00.000Z",
    consent_sequence: 1,
  });
}

beforeEach(() => {
  resetMocks();
  fake.tables.organizations = [
    { id: ORGANIZATION_ID, name: "Org", status: "active" },
  ];
  fake.tables.pilots = [
    {
      id: PILOT_ID,
      organization_id: ORGANIZATION_ID,
      name: "Pilot 002",
      status: "active",
    },
  ];
  fake.tables.pilot_memberships = [
    {
      id: "membership-1",
      organization_id: ORGANIZATION_ID,
      pilot_id: PILOT_ID,
      user_id: "tester-1",
      role: "tester",
      active: true,
      valid_from: "2026-09-01T00:00:00.000Z",
      valid_until: null,
    },
  ];
  fake.tables.telemetry_consents = [];
  fake.tables.test_sessions = [];
  fake.tables.test_events = [];
  fake.tables.activity_ingest_failures = [];
  fake.tables.test_recordings = [];
  fake.tables.test_feedback = [];
});

describe("normal Ask Jack pilot telemetry session ensure", () => {
  it("creates one consent-backed session and makes the Ask Jack event observable", async () => {
    grantTelemetry();
    const req = request();

    await ensureAskJackTelemetrySession(req, identity());

    expect(fake.tables.test_sessions).toHaveLength(1);
    expect(fake.tables.test_sessions[0]).toMatchObject({
      actor_user_id: "tester-1",
      organization_id: ORGANIZATION_ID,
      pilot_id: PILOT_ID,
      status: "active",
      telemetry_status: "granted",
      telemetry_consent_id: CONSENT_ID,
      device_category: "mobile",
      question_count: 0,
    });
    expect(req.headers["x-jack-test-session-id"]).toBe(
      fake.tables.test_sessions[0]?.id,
    );

    await recordServerAskJackEvent({
      req,
      actorIdentity: identity(),
      eventType: "ask_jack_completed",
      correlationId: "chat-message-1",
      citationCount: 2,
    });

    expect(fake.tables.test_sessions).toHaveLength(1);
    expect(fake.tables.test_sessions[0]?.question_count).toBe(1);
    expect(fake.tables.test_events).toHaveLength(1);
    expect(fake.tables.test_events[0]).toMatchObject({
      actor_user_id: "tester-1",
      organization_id: ORGANIZATION_ID,
      pilot_id: PILOT_ID,
      test_session_id: fake.tables.test_sessions[0]?.id,
      event_type: "ask_jack_completed",
      metadata: { citation_count: 2 },
      correlation_id: "chat-message-1",
    });
  });

  it("reuses an existing current-consent session without creating a duplicate", async () => {
    grantTelemetry();
    fake.tables.test_sessions = [
      {
        id: "44444444-4444-4444-8444-444444444444",
        actor_user_id: "tester-1",
        organization_id: ORGANIZATION_ID,
        pilot_id: PILOT_ID,
        app_session_id: "66666666-6666-4666-8666-666666666666",
        device_category: "desktop",
        status: "active",
        telemetry_status: "granted",
        telemetry_consent_id: CONSENT_ID,
        screen_consent_id: null,
        microphone_consent_id: null,
        screen_consent_state: "declined",
        microphone_consent_state: "declined",
        onboarding_status: "not_started",
        onboarding_step: 0,
        recording_status: "not_requested",
        feedback_status: "not_requested",
        question_count: 0,
        error_count: 0,
        started_at: "2026-09-03T20:00:00.000Z",
        last_activity_at: "2026-09-03T20:00:00.000Z",
        expires_at: "2026-09-10T20:00:00.000Z",
      },
    ];
    const req = request();

    await ensureAskJackTelemetrySession(req, identity());

    expect(fake.tables.test_sessions).toHaveLength(1);
    expect(req.headers["x-jack-test-session-id"]).toBe(
      "44444444-4444-4444-8444-444444444444",
    );
  });

  it("does not create a session without current explicit telemetry consent", async () => {
    const req = request();

    await ensureAskJackTelemetrySession(req, identity());

    expect(fake.tables.test_sessions).toHaveLength(0);
    expect(req.headers["x-jack-test-session-id"]).toBeUndefined();
  });

  it("fails closed instead of guessing when tester membership is ambiguous", async () => {
    grantTelemetry();
    fake.tables.pilots.push({
      id: OTHER_PILOT_ID,
      organization_id: ORGANIZATION_ID,
      name: "Other Pilot",
      status: "active",
    });
    fake.tables.pilot_memberships.push({
      id: "membership-2",
      organization_id: ORGANIZATION_ID,
      pilot_id: OTHER_PILOT_ID,
      user_id: "tester-1",
      role: "tester",
      active: true,
      valid_from: "2026-09-01T00:00:00.000Z",
      valid_until: null,
    });
    const req = request();

    await ensureAskJackTelemetrySession(req, identity());

    expect(fake.tables.test_sessions).toHaveLength(0);
    expect(req.headers["x-jack-test-session-id"]).toBeUndefined();
  });

  it.each([
    identity({ isAdmin: true }),
    identity({ isPresentation: true, classification: "restricted" }),
    identity({ classification: "unavailable" }),
  ])("does not create pilot telemetry for restricted identities", async (actorIdentity) => {
    grantTelemetry();
    const req = request();

    await ensureAskJackTelemetrySession(req, actorIdentity);

    expect(fake.tables.test_sessions).toHaveLength(0);
    expect(req.headers["x-jack-test-session-id"]).toBeUndefined();
  });
});
