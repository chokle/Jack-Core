import type { Request } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CallerIdentity } from "../admin-auth.js";

vi.mock("../supabase.js", async () => {
  const mocks = await import("./mocks.js");
  return { supabase: { from: (table: string) => mocks.fake.from(table) } };
});

import { fake, resetMocks } from "./mocks.js";
import {
  hasAnyReportScope,
  CONSENT_VERSION,
  PRIVACY_NOTICE_VERSION,
  recordServerAskJackEvent,
} from "../activity-telemetry.js";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const PILOT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_PILOT_ID = "33333333-3333-4333-8333-333333333333";
const SESSION_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_SESSION_ID = "55555555-5555-4555-8555-555555555555";
const CONSENT_ID = "88888888-8888-4888-8888-888888888888";

function request(sessionId?: string): Request {
  return {
    headers: {
      "user-agent": "Mozilla/5.0 Chrome/126.0",
      "x-request-id": "request-1",
      ...(sessionId ? { "x-jack-test-session-id": sessionId } : {}),
    },
    log: { warn: vi.fn() },
  } as unknown as Request;
}

function withdrawTelemetryAfterNextEventInsert() {
  const originalFrom = fake.from.bind(fake);
  let withdrawn = false;
  return vi.spyOn(fake, "from").mockImplementation((table: string) => {
    const query = originalFrom(table) as any;
    if (table !== "test_events") return query;
    const originalInsert = query.insert.bind(query);
    query.insert = (rows: Record<string, unknown> | Record<string, unknown>[]) => {
      const builder = originalInsert(rows);
      const originalThen = builder.then.bind(builder);
      builder.then = (
        onfulfilled?: (result: unknown) => unknown,
        onrejected?: (reason: unknown) => unknown,
      ) =>
        originalThen(
          (result: unknown) => {
            if (!withdrawn) {
              withdrawn = true;
              fake.tables.telemetry_consents.push({
                id: "99999999-9999-4999-8999-999999999999",
                actor_user_id: "tester-1",
                pilot_id: PILOT_ID,
                scope: "telemetry",
                state: "withdrawn",
                privacy_notice_version: PRIVACY_NOTICE_VERSION,
                consent_version: CONSENT_VERSION,
                occurred_at: "2026-07-26T00:00:00.000Z",
              });
            }
            return onfulfilled ? onfulfilled(result) : result;
          },
          onrejected,
        );
      return builder;
    };
    return query;
  });
}

function identity(
  overrides: Partial<CallerIdentity> = {},
): CallerIdentity {
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

beforeEach(() => {
  resetMocks();
  fake.tables.test_sessions = [
    {
      id: SESSION_ID,
      actor_user_id: "tester-1",
      organization_id: ORGANIZATION_ID,
      pilot_id: PILOT_ID,
      status: "active",
      telemetry_status: "granted",
      telemetry_consent_id: CONSENT_ID,
      app_session_id: "66666666-6666-4666-8666-666666666666",
      device_category: "desktop",
      question_count: 0,
      last_activity_at: "2026-07-25T00:00:00.000Z",
    },
    {
      id: OTHER_SESSION_ID,
      actor_user_id: "tester-1",
      organization_id: ORGANIZATION_ID,
      pilot_id: OTHER_PILOT_ID,
      status: "active",
      telemetry_status: "granted",
      telemetry_consent_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      app_session_id: "77777777-7777-4777-8777-777777777777",
      device_category: "desktop",
      question_count: 0,
      last_activity_at: "2026-07-25T01:00:00.000Z",
    },
  ];
  fake.tables.telemetry_consents = [
    {
      id: CONSENT_ID,
      actor_user_id: "tester-1",
      pilot_id: PILOT_ID,
      scope: "telemetry",
      state: "granted",
      privacy_notice_version: PRIVACY_NOTICE_VERSION,
      consent_version: CONSENT_VERSION,
      occurred_at: "2026-07-25T00:00:00.000Z",
    },
  ];
  fake.tables.test_events = [];
  fake.tables.activity_ingest_failures = [];
  fake.tables.test_recordings = [];
  fake.tables.test_feedback = [];
});

describe("server-authoritative Ask Jack telemetry", () => {
  it("does not guess when more than one active pilot session exists", async () => {
    await recordServerAskJackEvent({
      req: request(),
      actorIdentity: identity(),
      eventType: "ask_jack_completed",
      correlationId: "chat-message-1",
      citationCount: 2,
    });

    expect(fake.tables.test_events).toHaveLength(0);
  });

  it("uses an owned session hint and stores only allowlisted outcome metadata", async () => {
    await recordServerAskJackEvent({
      req: request(SESSION_ID),
      actorIdentity: identity(),
      eventType: "ask_jack_completed",
      correlationId: "chat-message-1",
      citationCount: 2,
    });

    expect(fake.tables.test_events).toHaveLength(1);
    expect(fake.tables.test_events[0]).toMatchObject({
      actor_user_id: "tester-1",
      pilot_id: PILOT_ID,
      test_session_id: SESSION_ID,
      event_type: "ask_jack_completed",
      metadata: { citation_count: 2 },
      correlation_id: "chat-message-1",
    });
    expect(JSON.stringify(fake.tables.test_events[0])).not.toContain("question");
    expect(JSON.stringify(fake.tables.test_events[0])).not.toContain("answer");
  });

  it("redacts a server Ask Jack event inserted after withdrawal", async () => {
    fake.tables.test_feedback = [{
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      tester_user_id: "tester-1",
      pilot_id: PILOT_ID,
      test_session_id: SESSION_ID,
      notification_status: "pending",
    }];
    const fromSpy = withdrawTelemetryAfterNextEventInsert();
    try {
      await recordServerAskJackEvent({
        req: request(SESSION_ID),
        actorIdentity: identity(),
        eventType: "ask_jack_completed",
        correlationId: "chat-message-race",
        citationCount: 1,
      });

      expect(fake.tables.test_sessions[0]).toMatchObject({
        status: "withdrawn",
        telemetry_status: "withdrawn",
        question_count: 0,
        deletion_due_at: expect.any(String),
      });
      expect(fake.tables.test_events).toHaveLength(1);
      expect(fake.tables.test_events[0]).toMatchObject({
        event_type: "ask_jack_completed",
        metadata: {},
        correlation_id: null,
        request_id: null,
        redacted_at: expect.any(String),
        deletion_due_at: expect.any(String),
      });
      expect(fake.tables.test_feedback[0]).toMatchObject({
        deletion_due_at: expect.any(String),
        notification_status: "failed",
        notification_last_error: "telemetry_consent_withdrawn",
      });
    } finally {
      fromSpy.mockRestore();
    }
  });

  it.each([
    {
      actorIdentity: identity({ isPresentation: true, classification: "restricted" }),
      label: "presentation identity",
    },
    {
      actorIdentity: identity({ classification: "unavailable" }),
      label: "unavailable identity",
    },
  ])("skips Ask Jack telemetry writes for $label", async ({ actorIdentity }) => {
    const originalQuestionCount = fake.tables.test_sessions[0]?.question_count;

    await recordServerAskJackEvent({
      req: request(SESSION_ID),
      actorIdentity,
      eventType: "ask_jack_failed",
      correlationId: "chat-message-2",
    });

    expect(fake.tables.test_events).toHaveLength(0);
    expect(fake.tables.test_sessions[0]?.question_count).toBe(originalQuestionCount);
  });

  it("returns true when any membership in the valid scope window is report-authorized", async () => {
    fake.tables.pilot_memberships = [
      {
        id: "membership-1",
        organization_id: ORGANIZATION_ID,
        pilot_id: PILOT_ID,
        user_id: "tester-1",
        role: "pilot_admin",
        active: true,
        valid_from: "2020-01-01T00:00:00.000Z",
        valid_until: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "membership-2",
        organization_id: ORGANIZATION_ID,
        pilot_id: PILOT_ID,
        user_id: "tester-1",
        role: "pilot_admin",
        active: true,
        valid_from: "2026-01-01T00:00:00.000Z",
        valid_until: null,
      },
    ];
    expect(await hasAnyReportScope("tester-1")).toBe(true);
  });
});
