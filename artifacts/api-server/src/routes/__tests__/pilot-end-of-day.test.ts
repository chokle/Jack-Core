import express, { type Express } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const identity = vi.hoisted(() => ({
  userId: "pilot-admin",
  email: "admin@example.test",
  name: "Pilot Admin",
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
import pilotEndOfDayRouter from "../pilot-end-of-day.js";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const PILOT_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const APP_SESSION_ID = "44444444-4444-4444-8444-444444444444";
const HEARTBEAT_ID = "55555555-5555-4555-8555-555555555555";
const query = `organizationId=${ORGANIZATION_ID}&pilotId=${PILOT_ID}`;

function app(): Express {
  const value = express();
  value.use(express.json());
  value.use((req, _res, next) => {
    (req as unknown as { log: { error: ReturnType<typeof vi.fn> } }).log = {
      error: vi.fn(),
    };
    next();
  });
  value.use("/api", pilotEndOfDayRouter);
  return value;
}

beforeEach(() => {
  resetMocks();
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-24T20:00:00.000Z"));
  Object.assign(identity, {
    userId: "pilot-admin",
    isAdmin: false,
    isPresentation: false,
    classification: "resolved",
  });
  fake.tables.organizations = [
    { id: ORGANIZATION_ID, name: "Allowed Org", status: "active" },
  ];
  fake.tables.pilots = [
    {
      id: PILOT_ID,
      organization_id: ORGANIZATION_ID,
      name: "Pilot001",
      status: "active",
    },
  ];
  fake.tables.pilot_memberships = [
    {
      id: "admin-membership",
      user_id: "pilot-admin",
      organization_id: ORGANIZATION_ID,
      pilot_id: PILOT_ID,
      role: "pilot_admin",
      active: true,
      valid_from: "2026-01-01T00:00:00.000Z",
      valid_until: null,
    },
    {
      id: "tester-membership",
      user_id: "tester-1",
      organization_id: ORGANIZATION_ID,
      pilot_id: PILOT_ID,
      role: "tester",
      active: true,
      valid_from: "2026-01-01T00:00:00.000Z",
      valid_until: null,
    },
  ];
  fake.tables.platform_roles = [];
  fake.tables.test_sessions = [
    {
      id: SESSION_ID,
      actor_user_id: "tester-1",
      organization_id: ORGANIZATION_ID,
      pilot_id: PILOT_ID,
      app_session_id: APP_SESSION_ID,
      status: "active",
      telemetry_status: "granted",
      started_at: "2026-08-24T19:58:00.000Z",
      last_activity_at: "2026-08-24T19:59:00.000Z",
      completed_at: null,
    },
  ];
  fake.tables.test_events = [
    {
      event_id: HEARTBEAT_ID,
      actor_user_id: "tester-1",
      organization_id: ORGANIZATION_ID,
      pilot_id: PILOT_ID,
      test_session_id: SESSION_ID,
      app_session_id: APP_SESSION_ID,
      event_type: "activity_heartbeat",
      occurred_at: "2026-08-24T19:59:00.000Z",
      metadata: {
        visibility: "hidden",
        meaningful_activity: false,
      },
    },
  ];
  fake.tables.test_feedback = [];
  fake.tables.activity_ingest_failures = [];
  fake.tables.admin_access_audit = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pilot end-of-day report route", () => {
  it("bounds the current UTC day at now so recent heartbeat coverage can verify telemetry", async () => {
    const response = await request(app()).get(
      `/api/testing/reports/end-of-day?${query}&date=2026-08-24`,
    );

    expect(response.status).toBe(200);
    expect(response.body.report.window).toEqual({
      start: "2026-08-24T00:00:00.000Z",
      end: "2026-08-24T20:00:00.000Z",
    });
    expect(response.body.report.reportState).toBe("VERIFIED_ZERO_ACTIVITY");
    expect(response.body.report.telemetryHealth).toMatchObject({
      complete: true,
      telemetryPathObserved: true,
    });
  });

  it("rejects future report dates instead of fabricating an empty day", async () => {
    const response = await request(app()).get(
      `/api/testing/reports/end-of-day?${query}&date=2026-08-25`,
    );

    expect(response.status).toBe(400);
  });
});
