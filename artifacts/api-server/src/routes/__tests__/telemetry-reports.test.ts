import express, { type Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
import telemetryReportsRouter from "../telemetry-reports.js";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const PILOT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ORGANIZATION_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_PILOT_ID = "44444444-4444-4444-8444-444444444444";
const USER_ID = "tester-1";
const query = `organizationId=${ORGANIZATION_ID}&pilotId=${PILOT_ID}`;
const SECOND_SESSION_ID = "66666666-6666-4666-8666-666666666666";
const THIRD_SESSION_ID = "77777777-7777-4777-8777-777777777777";

function app(): Express {
  const value = express();
  value.use(express.json());
  value.use((req, _res, next) => {
    (req as never as { log: { error: ReturnType<typeof vi.fn> } }).log = {
      error: vi.fn(),
    };
    next();
  });
  value.use("/api", telemetryReportsRouter);
  return value;
}

beforeEach(() => {
  resetMocks();
  Object.assign(identity, {
    userId: "pilot-admin",
    isAdmin: false,
    isPresentation: false,
    classification: "resolved",
  });
  fake.tables.organizations = [
    { id: ORGANIZATION_ID, name: "Allowed Org", status: "active" },
    { id: OTHER_ORGANIZATION_ID, name: "Other Org", status: "active" },
  ];
  fake.tables.pilots = [
    {
      id: PILOT_ID,
      organization_id: ORGANIZATION_ID,
      name: "Allowed Pilot",
      status: "active",
    },
    {
      id: OTHER_PILOT_ID,
      organization_id: OTHER_ORGANIZATION_ID,
      name: "Other Pilot",
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
      user_id: USER_ID,
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
      id: "55555555-5555-4555-8555-555555555555",
      actor_user_id: USER_ID,
      organization_id: ORGANIZATION_ID,
      pilot_id: PILOT_ID,
      chat_session_id: "pilot-chat-session-1",
      status: "completed",
      started_at: "2026-07-25T00:00:00.000Z",
      last_activity_at: "2026-07-25T01:00:00.000Z",
      onboarding_status: "completed",
      onboarding_step: 3,
      question_count: 1,
      screen_consent_state: "declined",
      microphone_consent_state: "declined",
      recording_status: "not_requested",
      feedback_status: "submitted",
      completed_at: "2026-07-25T01:00:00.000Z",
      error_count: 0,
    },
  ];
  fake.tables.test_events = [
    {
      event_id: "66666666-6666-4666-8666-666666666666",
      actor_user_id: USER_ID,
      organization_id: ORGANIZATION_ID,
      pilot_id: PILOT_ID,
      test_session_id: "55555555-5555-4555-8555-555555555555",
      event_type: "ask_jack_completed",
      occurred_at: "2026-07-25T00:30:00.000Z",
      surface: "ask_jack",
      result: "success",
      metadata: { citation_count: 2 },
      schema_version: 1,
    },
  ];
  fake.tables.test_feedback = [
    {
      id: "77777777-7777-4777-8777-777777777777",
      organization_id: ORGANIZATION_ID,
      pilot_id: PILOT_ID,
    },
  ];
  fake.tables.activity_ingest_failures = [];
  fake.tables.chat_messages = [];
  fake.tables.admin_access_audit = [];
  fake.tables.activity_report_runs = [];
});

describe("pilot activity reports", () => {
  it("returns scoped aggregates and a minimized per-user timeline", async () => {
    const summary = await request(app()).get(
      `/api/testing/reports/summary?${query}`,
    );
    expect(summary.status).toBe(200);
    expect(summary.body.summary).toMatchObject({
      aggregateUnit: "sessions",
      participantCount: 1,
      sessionCount: 1,
      completedSessions: 1,
      feedbackCount: 1,
    });
    expect(summary.body.participants).toEqual([
      expect.objectContaining({
        actorUserId: USER_ID,
        sessionCount: 1,
        askJackUseCount: 1,
        sessions: [expect.objectContaining({ actorUserId: USER_ID })],
      }),
    ]);
    expect(summary.body.sessions).toHaveLength(1);
    expect(summary.body).not.toHaveProperty("users");
    const timeline = await request(app()).get(
      `/api/testing/reports/users/${USER_ID}/timeline?${query}`,
    );
    expect(timeline.status).toBe(200);
    expect(timeline.body.events[0]).toEqual(
      expect.objectContaining({ eventType: "ask_jack_completed" }),
    );
    expect(JSON.stringify(timeline.body)).not.toContain("question");
  });

  it("groups repeated sessions under one primary participant", async () => {
    fake.tables.test_sessions.push({
      ...fake.tables.test_sessions[0],
      id: SECOND_SESSION_ID,
      status: "active",
      started_at: "2026-07-25T01:30:00.000Z",
      last_activity_at: "2026-07-25T02:00:00.000Z",
      onboarding_status: "not_started",
      onboarding_step: 0,
      question_count: 2,
      feedback_status: "not_requested",
      completed_at: null,
    });

    const response = await request(app()).get(
      `/api/testing/reports/summary?${query}`,
    );

    expect(response.status).toBe(200);
    expect(response.body.summary).toMatchObject({
      aggregateUnit: "sessions",
      participantCount: 1,
      sessionCount: 2,
      completedSessions: 1,
      completionRate: 0.5,
    });
    expect(response.body.participants).toHaveLength(1);
    expect(response.body.participants[0]).toMatchObject({
      actorUserId: USER_ID,
      sessionCount: 2,
      askJackUseCount: 3,
    });
    expect(response.body.participants[0].sessions).toHaveLength(2);
    expect(response.body.sessions).toHaveLength(2);
    expect(response.body.reconciliation.sessionCountsByActor).toEqual({
      [USER_ID]: 2,
    });
  });

  it("returns minimized scoped identity reconciliation without chat content", async () => {
    const enrolledWithoutActivity = "tester-2";
    const observedNotEnrolled = "tester-observed-only";
    fake.tables.pilot_memberships.push({
      id: "second-tester-membership",
      user_id: enrolledWithoutActivity,
      organization_id: ORGANIZATION_ID,
      pilot_id: PILOT_ID,
      role: "tester",
      active: true,
      valid_from: "2026-01-01T00:00:00.000Z",
      valid_until: null,
    });
    fake.tables.test_sessions.push({
      ...fake.tables.test_sessions[0],
      id: SECOND_SESSION_ID,
      actor_user_id: observedNotEnrolled,
      chat_session_id: "pilot-chat-session-observed",
    });
    fake.tables.chat_messages = [
      {
        id: "chat-1",
        user_id: USER_ID,
        session_id: "pilot-chat-session-1",
        organization_id: null,
        pilot_id: null,
        content: "private tester text",
        role: "user",
      },
      {
        id: "chat-2",
        user_id: USER_ID,
        session_id: "pilot-chat-session-1",
        organization_id: null,
        pilot_id: null,
        content: "private Jack text",
        role: "assistant",
      },
      {
        id: "chat-3",
        user_id: observedNotEnrolled,
        session_id: "pilot-chat-session-observed",
        organization_id: null,
        pilot_id: null,
        content: "private observed text",
        role: "user",
      },
      {
        id: "chat-personal",
        user_id: USER_ID,
        session_id: "personal-session",
        organization_id: null,
        pilot_id: null,
        content: "private personal activity",
        role: "user",
      },
      {
        id: "chat-4",
        user_id: "unrelated-user",
        session_id: "other-session",
        organization_id: null,
        pilot_id: null,
        content: "out of scope",
        role: "user",
      },
    ];

    const response = await request(app()).get(
      `/api/testing/reports/summary?${query}`,
    );

    expect(response.status).toBe(200);
    expect(response.body.reconciliation).toEqual({
      enrolledTesterIds: [USER_ID, enrolledWithoutActivity],
      observedSessionActorIds: [USER_ID, observedNotEnrolled],
      sessionCountsByActor: {
        [USER_ID]: 1,
        [enrolledWithoutActivity]: 0,
        [observedNotEnrolled]: 1,
      },
      chatActivityCountsByActor: {
        [USER_ID]: 2,
        [enrolledWithoutActivity]: 0,
        [observedNotEnrolled]: 1,
      },
      likelyMismatches: {
        observedNotEnrolled: [observedNotEnrolled],
        enrolledWithoutActivity: [enrolledWithoutActivity],
      },
    });
    expect(JSON.stringify(response.body)).not.toContain("private tester text");
    expect(JSON.stringify(response.body)).not.toContain(
      "private personal activity",
    );
    expect(JSON.stringify(response.body)).not.toContain("unrelated-user");
  });

  it("denies cross-organization access and presentation mode", async () => {
    const denied = await request(app()).get(
      `/api/testing/reports/summary?organizationId=${OTHER_ORGANIZATION_ID}&pilotId=${OTHER_PILOT_ID}`,
    );
    expect(denied.status).toBe(403);
    expect(fake.tables.admin_access_audit.at(-1)).toMatchObject({
      decision: "denied",
    });
    identity.userId = "clerk-presentation-account";
    identity.isPresentation = true;
    const presentation = await request(app()).get(
      `/api/testing/reports/summary?${query}`,
    );
    expect(presentation.status).toBe(403);
    const scopes = await request(app()).get("/api/testing/reports/scopes");
    expect(scopes.status).toBe(403);
  });

  it("fails closed when trusted identity resolution is unavailable", async () => {
    identity.classification = "unavailable";

    expect(
      (await request(app()).get(`/api/testing/reports/summary?${query}`))
        .status,
    ).toBe(503);
    expect(
      (await request(app()).get("/api/testing/reports/scopes")).status,
    ).toBe(503);
    expect(
      (
        await request(app()).get(
          `/api/testing/reports/users/${USER_ID}/timeline?${query}`,
        )
      ).status,
    ).toBe(503);
    expect(
      (await request(app()).get(`/api/testing/reports/export.csv?${query}`))
        .status,
    ).toBe(503);
    expect(
      (
        await request(app())
          .post(`/api/testing/reports/generate?${query}`)
          .send({ reportType: "pilot_summary" })
      ).status,
    ).toBe(503);
    expect(fake.tables.activity_report_runs).toHaveLength(0);
  });

  it("allows an active organization administrator only inside that organization", async () => {
    fake.tables.pilot_memberships[0] = {
      ...fake.tables.pilot_memberships[0],
      role: "organization_admin",
      pilot_id: null,
    };
    const allowed = await request(app()).get(
      `/api/testing/reports/summary?${query}`,
    );
    expect(allowed.status).toBe(200);
    const denied = await request(app()).get(
      `/api/testing/reports/summary?organizationId=${OTHER_ORGANIZATION_ID}&pilotId=${OTHER_PILOT_ID}`,
    );
    expect(denied.status).toBe(403);
  });

  it("allows cross-organization access only for an explicit platform-superadmin role", async () => {
    fake.tables.platform_roles = [
      {
        id: "platform-role",
        user_id: "pilot-admin",
        role: "platform_superadmin",
        active: true,
      },
    ];
    const response = await request(app()).get(
      `/api/testing/reports/summary?organizationId=${OTHER_ORGANIZATION_ID}&pilotId=${OTHER_PILOT_ID}`,
    );
    expect(response.status).toBe(200);
    expect(fake.tables.admin_access_audit.at(-1)).toMatchObject({
      decision: "allowed",
      authority: "platform_superadmin",
    });
  });

  it("exports CSV and persists only a derived manual report snapshot", async () => {
    const csv = await request(app()).get(
      `/api/testing/reports/export.csv?${query}`,
    );
    expect(csv.status).toBe(200);
    expect(csv.text).toContain("actor_user_id");
    expect(csv.text).not.toContain("citation_count");

    const generated = await request(app())
      .post(`/api/testing/reports/generate?${query}`)
      .send({ reportType: "pilot_summary" });
    expect(generated.status).toBe(201);
    expect(fake.tables.activity_report_runs[0]).toMatchObject({
      report_type: "pilot_summary",
      organization_id: ORGANIZATION_ID,
      pilot_id: PILOT_ID,
      status: "completed",
    });
  });

  it("exports CSV event_count for each session instead of duplicating actor totals", async () => {
    fake.tables.test_sessions.push(
      {
        id: SECOND_SESSION_ID,
        actor_user_id: USER_ID,
        organization_id: ORGANIZATION_ID,
        pilot_id: PILOT_ID,
        status: "active",
        started_at: "2026-07-25T01:30:00.000Z",
        last_activity_at: "2026-07-25T02:00:00.000Z",
        onboarding_status: "not_started",
        onboarding_step: 0,
        question_count: 0,
        screen_consent_state: "declined",
        microphone_consent_state: "declined",
        recording_status: "not_requested",
        feedback_status: "not_requested",
        completed_at: null,
        error_count: 0,
      },
      {
        id: THIRD_SESSION_ID,
        actor_user_id: USER_ID,
        organization_id: ORGANIZATION_ID,
        pilot_id: PILOT_ID,
        status: "active",
        started_at: "2026-07-25T02:30:00.000Z",
        last_activity_at: "2026-07-25T03:00:00.000Z",
        onboarding_status: "not_started",
        onboarding_step: 0,
        question_count: 0,
        screen_consent_state: "declined",
        microphone_consent_state: "declined",
        recording_status: "not_requested",
        feedback_status: "not_requested",
        completed_at: null,
        error_count: 0,
      },
    );
    fake.tables.test_events.push(
      {
        event_id: "88888888-8888-4888-8888-888888888888",
        actor_user_id: USER_ID,
        organization_id: ORGANIZATION_ID,
        pilot_id: PILOT_ID,
        test_session_id: SECOND_SESSION_ID,
        event_type: "test_started",
        occurred_at: "2026-07-25T01:45:00.000Z",
        surface: "pilot",
        result: "success",
        metadata: {},
        schema_version: 1,
      },
      {
        event_id: "88888888-8888-4888-8888-888888888889",
        actor_user_id: USER_ID,
        organization_id: ORGANIZATION_ID,
        pilot_id: PILOT_ID,
        test_session_id: THIRD_SESSION_ID,
        event_type: "test_started",
        occurred_at: "2026-07-25T02:45:00.000Z",
        surface: "pilot",
        result: "success",
        metadata: {},
        schema_version: 1,
      },
      {
        event_id: "88888888-8888-4888-8888-888888888890",
        actor_user_id: USER_ID,
        organization_id: ORGANIZATION_ID,
        pilot_id: PILOT_ID,
        test_session_id: THIRD_SESSION_ID,
        event_type: "ask_jack_completed",
        occurred_at: "2026-07-25T02:46:00.000Z",
        surface: "ask_jack",
        result: "success",
        metadata: { citation_count: 1 },
        schema_version: 1,
      },
    );

    const csv = await request(app()).get(
      `/api/testing/reports/export.csv?${query}`,
    );
    expect(csv.status).toBe(200);
    const lines = csv.text.trim().split(/\r?\n/);
    const headers =
      lines[0]?.split(",").map((header) => header.replace(/^\"|\"$/g, "")) ??
      [];
    expect(headers).toContain("event_count");
    const rows = lines
      .slice(1)
      .filter((line) => line.trim().length > 0)
      .map((line) =>
        Object.fromEntries(
          (line.split(/,(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)/) as string[]).map(
            (value, index) => [
              headers[index] ?? `column_${index}`,
              value.replace(/^\"|\"$/g, ""),
            ],
          ),
        ),
      );
    const countsBySessionStart = Object.fromEntries(
      rows.map((row) => [String(row.started_at), row.event_count]),
    );
    expect(countsBySessionStart["2026-07-25T00:00:00.000Z"]).toBe("1");
    expect(countsBySessionStart["2026-07-25T01:30:00.000Z"]).toBe("1");
    expect(countsBySessionStart["2026-07-25T02:30:00.000Z"]).toBe("2");
  });
});
