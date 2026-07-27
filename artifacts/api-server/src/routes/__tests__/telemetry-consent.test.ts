import express, { type Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const identity = vi.hoisted(() => ({
  userId: "tester-1",
  email: "tester@example.test",
  name: "Tester",
  isAdmin: false,
  isPresentation: false,
}));

vi.mock("../../lib/supabase.js", async () => {
  const mocks = await import("../../lib/__tests__/mocks.js");
  return { supabase: { from: mocks.fake.from.bind(mocks.fake) } };
});
vi.mock("../../lib/admin-auth.js", () => ({
  resolveIdentity: vi.fn(async () => ({ ...identity })),
}));

import { fake, resetMocks } from "../../lib/__tests__/mocks.js";
import telemetryConsentRouter from "../telemetry-consent.js";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const PILOT_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";

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

beforeEach(() => {
  resetMocks();
  Object.assign(identity, { userId: "tester-1", isAdmin: false, isPresentation: false });
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
  fake.tables.test_sessions = [];
  fake.tables.test_events = [];
  fake.tables.test_recordings = [];
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
    fake.tables.test_sessions = [{
      id: SESSION_ID,
      actor_user_id: "tester-1",
      pilot_id: PILOT_ID,
      organization_id: ORGANIZATION_ID,
      status: "active",
      telemetry_status: "granted",
    }];
    fake.tables.test_events = [{
      event_id: "44444444-4444-4444-8444-444444444444",
      actor_user_id: "tester-1",
      pilot_id: PILOT_ID,
      metadata: { feature: "library" },
      correlation_id: "request-1",
    }];
    fake.tables.test_recordings = [{
      id: "55555555-5555-4555-8555-555555555555",
      tester_user_id: "tester-1",
      test_session_id: SESSION_ID,
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
    expect(fake.tables.activity_report_runs).toHaveLength(1);
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

  it("stops active recording and schedules microphone-bearing media when mic consent is withdrawn", async () => {
    fake.tables.test_sessions = [{
      id: SESSION_ID,
      actor_user_id: "tester-1",
      pilot_id: PILOT_ID,
      organization_id: ORGANIZATION_ID,
      status: "active",
      telemetry_status: "granted",
      screen_consent_state: "granted",
      microphone_consent_state: "granted",
      recording_status: "recording",
    }];
    fake.tables.test_recordings = [{
      id: "55555555-5555-4555-8555-555555555555",
      tester_user_id: "tester-1",
      pilot_id: PILOT_ID,
      microphone_consent_id: "66666666-6666-4666-8666-666666666666",
    }];

    const response = await request(app())
      .post("/api/testing/telemetry/withdraw")
      .send({ pilotId: PILOT_ID, scopes: ["microphone"] });

    expect(response.status).toBe(200);
    expect(fake.tables.test_sessions[0]).toMatchObject({
      microphone_consent_state: "withdrawn",
      recording_status: "withdrawn",
    });
    expect(fake.tables.test_recordings[0]).toMatchObject({
      deletion_due_at: expect.any(String),
    });
  });
});
