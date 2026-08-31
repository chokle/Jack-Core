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
  return { supabase: { from: (table: string) => mocks.fake.from(table) } };
});
vi.mock("../../lib/admin-auth.js", () => ({
  resolveIdentity: vi.fn(async () => ({ ...identity })),
}));

import { fake, resetMocks } from "../../lib/__tests__/mocks.js";
import testSessionsRouter from "../test-sessions.js";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const PILOT_ID = "22222222-2222-4222-8222-222222222222";
const APP_SESSION_ID = "33333333-3333-4333-8333-333333333333";
const CONSENT_ID = "44444444-4444-4444-8444-444444444444";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const noop = () => {};
    (req as unknown as { log: Record<string, () => void> }).log = {
      warn: noop,
      error: noop,
      info: noop,
      debug: noop,
    };
    next();
  });
  app.use("/api", testSessionsRouter);
  return app;
}

const app = makeApp();
const startBody = {
  pilotId: PILOT_ID,
  appSessionId: APP_SESSION_ID,
  deviceCategory: "desktop",
};

type ConsentScope = "telemetry" | "screen" | "microphone";

function appendConsentWithdrawal(scope: ConsentScope): void {
  const ids: Record<ConsentScope, string> = {
    telemetry: "abababab-abab-4bab-8bab-abababababab",
    screen: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
    microphone: "efefefef-efef-4fef-8fef-efefefefefef",
  };
  fake.tables.telemetry_consents.push({
    id: ids[scope],
    actor_user_id: "tester-1",
    organization_id: ORGANIZATION_ID,
    pilot_id: PILOT_ID,
    scope,
    state: "withdrawn",
    privacy_notice_version: "jack-pilot-privacy-2026-07-25",
    consent_version: "jack-pilot-consent-2026-07-25",
    occurred_at: "2026-07-26T00:00:00.000Z",
  });
}

function appendTelemetryWithdrawal(): void {
  appendConsentWithdrawal("telemetry");
}

function withdrawConsentAfterNextInsert(
  tableName: string,
  scope: ConsentScope,
) {
  const originalFrom = fake.from.bind(fake);
  let withdrawn = false;
  return vi.spyOn(fake, "from").mockImplementation((table: string) => {
    const query = originalFrom(table) as any;
    if (table !== tableName) return query;
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
              appendConsentWithdrawal(scope);
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

function withdrawTelemetryAfterNextInsert(tableName: string) {
  return withdrawConsentAfterNextInsert(tableName, "telemetry");
}

function completeSessionAfterNextEventInsert() {
  const originalFrom = fake.from.bind(fake);
  let completed = false;
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
            if (!completed) {
              completed = true;
              fake.tables.test_sessions[0]!.status = "completed";
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

function completeSessionBeforeResumeUpdate() {
  const originalFrom = fake.from.bind(fake);
  return vi.spyOn(fake, "from").mockImplementation((table: string) => {
    const query = originalFrom(table) as any;
    if (table !== "test_sessions") return query;
    const originalUpdate = query.update.bind(query);
    query.update = (values: Record<string, unknown>) => {
      if ("resumed_at" in values) {
        fake.tables.test_sessions[0]!.status = "completed";
      }
      return originalUpdate(values);
    };
    return query;
  });
}

beforeEach(() => {
  resetMocks();
  Object.assign(identity, {
    userId: "tester-1",
    email: "tester@example.test",
    name: "Taylor Tester",
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
    id: "membership-1",
    organization_id: ORGANIZATION_ID,
    pilot_id: PILOT_ID,
    user_id: "tester-1",
    role: "tester",
    active: true,
    valid_from: "2026-01-01T00:00:00.000Z",
    valid_until: null,
  }];
  fake.tables.telemetry_consents = ["telemetry", "screen", "microphone"].map((scope, index) => ({
    id: index === 0 ? CONSENT_ID : `55555555-5555-4555-8555-55555555555${index}`,
    actor_user_id: "tester-1",
    organization_id: ORGANIZATION_ID,
    pilot_id: PILOT_ID,
    scope,
    state: scope === "telemetry" ? "granted" : "declined",
    privacy_notice_version: "jack-pilot-privacy-2026-07-25",
    consent_version: "jack-pilot-consent-2026-07-25",
    occurred_at: "2026-07-25T00:00:00.000Z",
  }));
  fake.tables.test_sessions = [];
  fake.tables.test_events = [];
  fake.tables.activity_ingest_failures = [];
  fake.tables.test_feedback = [];
});

describe("canonical user-test sessions", () => {
  it("creates one active session and emits started then resumed", async () => {
    const first = await request(app).post("/api/testing/sessions/start").send(startBody);
    const second = await request(app).post("/api/testing/sessions/start").send(startBody);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.session.id).toBe(first.body.session.id);
    expect(fake.tables.test_sessions).toHaveLength(1);
    expect(fake.tables.test_events.map((event) => event.event_type)).toEqual([
      "test_started",
      "test_resumed",
    ]);
  });

  it("does not resume a session completed after the active-session read", async () => {
    const first = await request(app).post("/api/testing/sessions/start").send(startBody);
    const fromSpy = completeSessionBeforeResumeUpdate();
    try {
      const response = await request(app).post("/api/testing/sessions/start").send(startBody);

      expect(response.status).toBe(409);
      expect(response.body.error).toContain("pilot session changed");
      expect(fake.tables.test_sessions).toHaveLength(1);
      expect(fake.tables.test_sessions[0]).toMatchObject({
        id: first.body.session.id,
        status: "completed",
        telemetry_status: "granted",
      });
      expect(fake.tables.test_sessions[0]?.deletion_due_at).toBeUndefined();
      expect(fake.tables.test_events.map((event) => event.event_type)).toEqual([
        "test_started",
      ]);
    } finally {
      fromSpy.mockRestore();
    }
  });

  it("withdraws a newly inserted session when consent changes before its start event", async () => {
    const fromSpy = withdrawTelemetryAfterNextInsert("test_sessions");
    try {
      const response = await request(app).post("/api/testing/sessions/start").send(startBody);

      expect(response.status).toBe(409);
      expect(response.body.error).toContain("Telemetry consent changed");
      expect(fake.tables.test_sessions).toHaveLength(1);
      expect(fake.tables.test_sessions[0]).toMatchObject({
        status: "withdrawn",
        telemetry_status: "withdrawn",
        screen_consent_state: "withdrawn",
        microphone_consent_state: "withdrawn",
        recording_status: "withdrawn",
      });
      expect(fake.tables.test_sessions[0]?.deletion_due_at).toEqual(expect.any(String));
      expect(fake.tables.test_events).toHaveLength(0);
    } finally {
      fromSpy.mockRestore();
    }
  });

  it.each(["screen", "microphone"] as const)(
    "rejects a stale %s grant if it is withdrawn during session insert",
    async (scope) => {
      const screenConsent = fake.tables.telemetry_consents.find(
        (consent) => consent.scope === "screen",
      );
      expect(screenConsent).toBeDefined();
      screenConsent!.state = "granted";
      if (scope === "microphone") {
        const microphoneConsent = fake.tables.telemetry_consents.find(
          (consent) => consent.scope === "microphone",
        );
        expect(microphoneConsent).toBeDefined();
        microphoneConsent!.state = "granted";
      }
      const fromSpy = withdrawConsentAfterNextInsert("test_sessions", scope);
      try {
        const response = await request(app)
          .post("/api/testing/sessions/start")
          .send(startBody);

        expect(response.status).toBe(409);
        expect(response.body.error).toContain("Telemetry consent changed");
        expect(fake.tables.test_sessions[0]).toMatchObject({
          status: "withdrawn",
          telemetry_status: "withdrawn",
          screen_consent_state: "withdrawn",
          microphone_consent_state: "withdrawn",
        });
        expect(fake.tables.test_events).toHaveLength(0);
      } finally {
        fromSpy.mockRestore();
      }
    },
  );

  it("redacts and schedules a start event when consent changes after its insert", async () => {
    const fromSpy = withdrawTelemetryAfterNextInsert("test_events");
    try {
      const response = await request(app).post("/api/testing/sessions/start").send(startBody);

      expect(response.status).toBe(409);
      expect(response.body.error).toContain("Telemetry consent changed");
      expect(fake.tables.test_sessions[0]).toMatchObject({
        status: "withdrawn",
        telemetry_status: "withdrawn",
      });
      expect(fake.tables.test_sessions[0]?.deletion_due_at).toEqual(expect.any(String));
      expect(fake.tables.test_events).toHaveLength(1);
      expect(fake.tables.test_events[0]).toMatchObject({
        event_type: "test_started",
        metadata: {},
        correlation_id: null,
        request_id: null,
      });
      expect(fake.tables.test_events[0]?.redacted_at).toEqual(expect.any(String));
      expect(fake.tables.test_events[0]?.deletion_due_at).toEqual(expect.any(String));
    } finally {
      fromSpy.mockRestore();
    }
  });

  it("redacts an expired-session event when withdrawal wins its insert race", async () => {
    const first = await request(app).post("/api/testing/sessions/start").send(startBody);
    fake.tables.test_sessions[0]!.expires_at = "2020-01-01T00:00:00.000Z";
    const fromSpy = withdrawTelemetryAfterNextInsert("test_events");
    try {
      const response = await request(app).post("/api/testing/sessions/start").send(startBody);

      expect(response.status).toBe(409);
      expect(response.body.error).toContain("Telemetry consent changed");
      expect(fake.tables.test_sessions).toHaveLength(2);
      expect(fake.tables.test_sessions.every((session) => session.status === "withdrawn")).toBe(
        true,
      );
      const expiredEvent = fake.tables.test_events.find(
        (event) =>
          event.test_session_id === first.body.session.id &&
          event.event_type === "test_expired",
      );
      expect(expiredEvent).toMatchObject({
        metadata: {},
        correlation_id: null,
        request_id: null,
      });
      expect(expiredEvent?.redacted_at).toEqual(expect.any(String));
      expect(expiredEvent?.deletion_due_at).toEqual(expect.any(String));
    } finally {
      fromSpy.mockRestore();
    }
  });

  it("expires a stale session and creates a fresh canonical session", async () => {
    const first = await request(app).post("/api/testing/sessions/start").send(startBody);
    fake.tables.test_sessions[0]!.expires_at = "2020-01-01T00:00:00.000Z";
    const second = await request(app).post("/api/testing/sessions/start").send(startBody);
    expect(second.status).toBe(201);
    expect(second.body.session.id).not.toBe(first.body.session.id);
    expect(fake.tables.test_sessions[0]!.status).toBe("expired");
    expect(fake.tables.test_events.map((event) => event.event_type)).toContain("test_expired");
  });

  it("redacts a foreground event inserted after telemetry withdrawal", async () => {
    const started = await request(app).post("/api/testing/sessions/start").send(startBody);
    fake.tables.test_feedback = [{
      id: "12121212-1212-4212-8212-121212121212",
      tester_user_id: "tester-1",
      pilot_id: PILOT_ID,
      test_session_id: started.body.session.id,
      notification_status: "pending",
    }];
    const fromSpy = withdrawTelemetryAfterNextInsert("test_events");
    try {
      const response = await request(app)
        .post(`/api/testing/sessions/${started.body.session.id}/events`)
        .send({
          eventId: "13131313-1313-4313-8313-131313131313",
          eventType: "feature_viewed",
          occurredAt: new Date().toISOString(),
          appSessionId: APP_SESSION_ID,
          metadata: { feature: "library" },
          result: "success",
          deviceCategory: "desktop",
          schemaVersion: 1,
        });

      expect(response.status).toBe(409);
      expect(fake.tables.test_sessions[0]).toMatchObject({
        status: "withdrawn",
        telemetry_status: "withdrawn",
      });
      const insertedEvent = fake.tables.test_events.find(
        (event) => event.event_id === "13131313-1313-4313-8313-131313131313",
      );
      expect(insertedEvent).toMatchObject({
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
        notification_next_attempt_at: null,
      });
    } finally {
      fromSpy.mockRestore();
    }
  });

  it("redacts only the losing event after a normal terminal transition", async () => {
    const started = await request(app).post("/api/testing/sessions/start").send(startBody);
    fake.tables.test_feedback = [{
      id: "16161616-1616-4616-8616-161616161616",
      tester_user_id: "tester-1",
      pilot_id: PILOT_ID,
      test_session_id: started.body.session.id,
      notification_status: "pending",
    }];
    const fromSpy = completeSessionAfterNextEventInsert();
    try {
      const response = await request(app)
        .post(`/api/testing/sessions/${started.body.session.id}/events`)
        .send({
          eventId: "17171717-1717-4717-8717-171717171717",
          eventType: "feature_viewed",
          occurredAt: new Date().toISOString(),
          appSessionId: APP_SESSION_ID,
          metadata: { feature: "library" },
          result: "success",
          deviceCategory: "desktop",
          schemaVersion: 1,
        });

      expect(response.status).toBe(409);
      expect(fake.tables.test_sessions[0]).toMatchObject({
        status: "completed",
        telemetry_status: "granted",
      });
      expect(fake.tables.test_sessions[0]?.deletion_due_at).toBeUndefined();
      const losingEvent = fake.tables.test_events.find(
        (event) => event.event_id === "17171717-1717-4717-8717-171717171717",
      );
      expect(losingEvent).toMatchObject({
        metadata: {},
        correlation_id: null,
        request_id: null,
        redacted_at: expect.any(String),
        deletion_due_at: expect.any(String),
      });
      expect(
        fake.tables.test_events.find((event) => event.event_type === "test_started")
          ?.redacted_at,
      ).toBeUndefined();
      expect(fake.tables.test_feedback[0]).toMatchObject({
        notification_status: "pending",
      });
      expect(fake.tables.test_feedback[0]?.deletion_due_at).toBeUndefined();
    } finally {
      fromSpy.mockRestore();
    }
  });

  it("rejects duplicate projection after telemetry withdrawal", async () => {
    const started = await request(app).post("/api/testing/sessions/start").send(startBody);
    const event = {
      eventId: "14141414-1414-4414-8414-141414141414",
      eventType: "feature_viewed",
      occurredAt: new Date().toISOString(),
      appSessionId: APP_SESSION_ID,
      metadata: { feature: "library" },
      result: "success",
      deviceCategory: "desktop",
      schemaVersion: 1,
    };
    expect(
      (
        await request(app)
          .post(`/api/testing/sessions/${started.body.session.id}/events`)
          .send(event)
      ).status,
    ).toBe(201);

    appendTelemetryWithdrawal();
    fake.tables.test_sessions[0]!.status = "withdrawn";
    fake.tables.test_sessions[0]!.telemetry_status = "withdrawn";
    const retry = await request(app)
      .post(`/api/testing/sessions/${started.body.session.id}/events`)
      .send(event);

    expect(retry.status).toBe(409);
    expect(fake.tables.test_sessions[0]!.status).toBe("withdrawn");
    expect(
      fake.tables.test_events.filter((row) => row.event_id === event.eventId),
    ).toHaveLength(1);
    expect(
      fake.tables.test_events.find((row) => row.event_id === event.eventId),
    ).toMatchObject({
      redacted_at: expect.any(String),
      deletion_due_at: expect.any(String),
    });
  });

  it("rejects a conflicting payload that reuses an existing event id", async () => {
    const started = await request(app).post("/api/testing/sessions/start").send(startBody);
    const event = {
      eventId: "15151515-1515-4515-8515-151515151515",
      eventType: "feature_viewed",
      occurredAt: new Date().toISOString(),
      appSessionId: APP_SESSION_ID,
      metadata: { feature: "library" },
      result: "success",
      deviceCategory: "desktop",
      schemaVersion: 1,
    };
    expect(
      (
        await request(app)
          .post(`/api/testing/sessions/${started.body.session.id}/events`)
          .send(event)
      ).status,
    ).toBe(201);

    const conflict = await request(app)
      .post(`/api/testing/sessions/${started.body.session.id}/events`)
      .send({ ...event, metadata: { feature: "memory_graph" } });

    expect(conflict.status).toBe(400);
    expect(conflict.body.code).toBe("idempotency_conflict");
    expect(
      fake.tables.test_events.filter((row) => row.event_id === event.eventId),
    ).toHaveLength(1);
  });

  it("deletes an ingest-failure counter inserted after withdrawal", async () => {
    const started = await request(app).post("/api/testing/sessions/start").send(startBody);
    const fromSpy = withdrawTelemetryAfterNextInsert("activity_ingest_failures");
    try {
      const response = await request(app)
        .post(`/api/testing/sessions/${started.body.session.id}/ingest-failures`)
        .send({ reasonCode: "queue_overflow", eventCount: 2 });

      expect(response.status).toBe(409);
      expect(fake.tables.activity_ingest_failures).toHaveLength(0);
      expect(fake.tables.test_sessions[0]).toMatchObject({
        status: "withdrawn",
        telemetry_status: "withdrawn",
      });
    } finally {
      fromSpy.mockRestore();
    }
  });

  it("does not persist an unscoped failure for an invalid withdrawn envelope", async () => {
    const started = await request(app).post("/api/testing/sessions/start").send(startBody);
    appendTelemetryWithdrawal();
    fake.tables.test_sessions[0]!.status = "withdrawn";
    fake.tables.test_sessions[0]!.telemetry_status = "withdrawn";

    const response = await request(app)
      .post(`/api/testing/sessions/${started.body.session.id}/events`)
      .send({ schemaVersion: 2 });

    expect(response.status).toBe(400);
    expect(fake.tables.activity_ingest_failures).toHaveLength(0);
  });

  it("accepts minimized events and rejects raw content metadata", async () => {
    const started = await request(app).post("/api/testing/sessions/start").send(startBody);
    const eventBase = {
      eventId: "66666666-6666-4666-8666-666666666666",
      occurredAt: new Date().toISOString(),
      appSessionId: APP_SESSION_ID,
      result: "success",
      deviceCategory: "desktop",
      schemaVersion: 1,
    };
    const accepted = await request(app)
      .post(`/api/testing/sessions/${started.body.session.id}/events`)
      .send({
        ...eventBase,
        eventType: "feature_viewed",
        metadata: { feature: "library" },
        dedupeKey: "feature:library",
      });
    expect(accepted.status).toBe(201);
    expect(fake.tables.test_events.at(-1)?.metadata).toEqual({ feature: "library" });

    const rejected = await request(app)
      .post(`/api/testing/sessions/${started.body.session.id}/events`)
      .send({
        ...eventBase,
        eventId: "77777777-7777-4777-8777-777777777777",
        eventType: "feature_viewed",
        metadata: { feature: "library", prompt: "secret question" },
      });
    expect(rejected.status).toBe(400);
    expect(fake.tables.activity_ingest_failures.at(-1)).toMatchObject({
      outcome: "rejected",
      reason_code: "invalid_metadata",
    });
  });

  it("rejects invalid start metadata before creating a session", async () => {
    const response = await request(app)
      .post("/api/testing/sessions/start")
      .send({ ...startBody, deviceCategory: "smart-fridge" });
    expect(response.status).toBe(400);
    expect(fake.tables.test_sessions).toHaveLength(0);
    expect(fake.tables.test_events).toHaveLength(0);
  });

  it("accepts an idempotent retry after a terminal event completed the session", async () => {
    const started = await request(app).post("/api/testing/sessions/start").send(startBody);
    const event = {
      eventId: "99999999-9999-4999-8999-999999999999",
      eventType: "test_completed",
      occurredAt: new Date().toISOString(),
      appSessionId: APP_SESSION_ID,
      metadata: {},
      result: "success",
      deviceCategory: "desktop",
      schemaVersion: 1,
    };
    const first = await request(app)
      .post(`/api/testing/sessions/${started.body.session.id}/events`)
      .send(event);
    const retry = await request(app)
      .post(`/api/testing/sessions/${started.body.session.id}/events`)
      .send(event);
    expect(first.status).toBe(201);
    expect(first.body.session.status).toBe("completed");
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ accepted: true, duplicate: true });
    expect(fake.tables.test_events.filter((row) => row.event_id === event.eventId)).toHaveLength(1);
  });

  it("replays event projection on duplicate retry even if stored session state drifted", async () => {
    const started = await request(app).post("/api/testing/sessions/start").send(startBody);
    const event = {
      eventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      eventType: "test_completed",
      occurredAt: new Date().toISOString(),
      appSessionId: APP_SESSION_ID,
      metadata: {},
      result: "success",
      deviceCategory: "desktop",
      schemaVersion: 1,
    };
    const first = await request(app)
      .post(`/api/testing/sessions/${started.body.session.id}/events`)
      .send(event);
    expect(first.status).toBe(201);
    expect(first.body.session.status).toBe("completed");
    fake.tables.test_sessions[0]!.status = "active";
    fake.tables.test_sessions[0]!.completed_at = null;
    const retry = await request(app)
      .post(`/api/testing/sessions/${started.body.session.id}/events`)
      .send(event);

    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ accepted: true, duplicate: true, session: { status: "completed" } });
    expect(fake.tables.test_events.filter((row) => row.event_id === event.eventId)).toHaveLength(1);
    expect(fake.tables.test_sessions[0]!.status).toBe("completed");
  });

  it("rejects a dedupe-key collision without applying the conflicting session outcome", async () => {
    const started = await request(app).post("/api/testing/sessions/start").send(startBody);
    const base = {
      occurredAt: new Date().toISOString(),
      appSessionId: APP_SESSION_ID,
      metadata: {},
      result: "success",
      deviceCategory: "desktop",
      schemaVersion: 1,
      dedupeKey: "workflow:terminal",
    };
    const first = await request(app)
      .post(`/api/testing/sessions/${started.body.session.id}/events`)
      .send({
        ...base,
        eventId: "11111111-2222-4333-8444-555555555555",
        eventType: "feature_viewed",
        metadata: { feature: "library" },
      });
    const collision = await request(app)
      .post(`/api/testing/sessions/${started.body.session.id}/events`)
      .send({
        ...base,
        eventId: "99999999-8888-4777-8666-555555555555",
        eventType: "test_completed",
      });

    expect(first.status).toBe(201);
    expect(collision.status).toBe(400);
    expect(collision.body.code).toBe("idempotency_conflict");
    expect(fake.tables.test_sessions[0]?.status).toBe("active");
    expect(fake.tables.test_events).toHaveLength(2);
    expect(fake.tables.test_events.some((row) => row.event_type === "test_completed")).toBe(false);
  });

  it("records payload-free dropped counters only while consent remains active", async () => {
    const started = await request(app).post("/api/testing/sessions/start").send(startBody);
    const accepted = await request(app)
      .post(`/api/testing/sessions/${started.body.session.id}/ingest-failures`)
      .send({ reasonCode: "queue_overflow", eventCount: 2 });
    expect(accepted.status).toBe(202);
    expect(fake.tables.activity_ingest_failures.at(-1)).toMatchObject({
      reason_code: "queue_overflow",
      outcome: "dropped",
      event_count: 2,
    });

    fake.tables.telemetry_consents[0]!.state = "withdrawn";
    const rejected = await request(app)
      .post(`/api/testing/sessions/${started.body.session.id}/ingest-failures`)
      .send({ reasonCode: "queue_overflow", eventCount: 1 });
    expect(rejected.status).toBe(409);
    expect(fake.tables.activity_ingest_failures).toHaveLength(1);
  });

  it("enforces ownership, explicit consent, admin exemption, and presentation denial", async () => {
    const started = await request(app).post("/api/testing/sessions/start").send(startBody);
    identity.userId = "tester-2";
    const foreign = await request(app)
      .post(`/api/testing/sessions/${started.body.session.id}/events`)
      .send({
        eventId: "88888888-8888-4888-8888-888888888888",
        eventType: "feature_viewed",
        occurredAt: new Date().toISOString(),
        appSessionId: APP_SESSION_ID,
        metadata: { feature: "library" },
        result: "success",
        deviceCategory: "desktop",
        schemaVersion: 1,
      });
    expect(foreign.status).toBe(404);

    identity.userId = "tester-1";
    fake.tables.telemetry_consents[0]!.state = "declined";
    expect(
      (await request(app).post("/api/testing/sessions/start").send(startBody)).status,
    ).toBe(412);
    identity.isAdmin = true;
    expect(
      (await request(app).post("/api/testing/sessions/start").send(startBody)).status,
    ).toBe(403);
    identity.isAdmin = false;
    identity.userId = "clerk-presentation-account";
    identity.isPresentation = true;
    expect(
      (await request(app).post("/api/testing/sessions/start").send(startBody)).status,
    ).toBe(403);
    expect(
      (await request(app).get(`/api/testing/sessions/current?pilotId=${PILOT_ID}`)).status,
    ).toBe(403);

    identity.userId = "presentation-demo";
    identity.isPresentation = false;
    expect(
      (await request(app).get(`/api/testing/sessions/current?pilotId=${PILOT_ID}`)).status,
    ).toBe(403);
  });

  it("fails closed when trusted identity resolution is unavailable", async () => {
    identity.classification = "unavailable";

    expect((await request(app).post("/api/testing/sessions/start").send(startBody)).status).toBe(503);
    expect((await request(app).get(`/api/testing/sessions/current?pilotId=${PILOT_ID}`)).status).toBe(503);
    expect(
      (
        await request(app)
          .post("/api/testing/sessions/99999999-9999-4999-8999-999999999999/events")
          .send({
            eventId: "88888888-8888-4888-8888-888888888888",
            eventType: "feature_viewed",
            occurredAt: new Date().toISOString(),
            appSessionId: APP_SESSION_ID,
            metadata: { feature: "library" },
            result: "success",
            deviceCategory: "desktop",
            schemaVersion: 1,
          })
      ).status,
    ).toBe(503);
    expect(
      (
        await request(app)
          .post("/api/testing/sessions/99999999-9999-4999-8999-999999999999/ingest-failures")
          .send({ reasonCode: "queue_overflow", eventCount: 1 })
      ).status,
    ).toBe(503);
  });
});
