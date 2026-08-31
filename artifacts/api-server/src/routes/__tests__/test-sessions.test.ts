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

function appendTelemetryWithdrawal(): void {
  fake.tables.telemetry_consents.push({
    id: "abababab-abab-4bab-8bab-abababababab",
    actor_user_id: "tester-1",
    organization_id: ORGANIZATION_ID,
    pilot_id: PILOT_ID,
    scope: "telemetry",
    state: "withdrawn",
    privacy_notice_version: "jack-pilot-privacy-2026-07-25",
    consent_version: "jack-pilot-consent-2026-07-25",
    occurred_at: "2026-07-26T00:00:00.000Z",
  });
}

function withdrawTelemetryAfterNextInsert(tableName: string) {
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
              appendTelemetryWithdrawal();
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

  it("expires a stale session and creates a fresh canonical session", async () => {
    const first = await request(app).post("/api/testing/sessions/start").send(startBody);
    fake.tables.test_sessions[0]!.expires_at = "2020-01-01T00:00:00.000Z";
    const second = await request(app).post("/api/testing/sessions/start").send(startBody);
    expect(second.status).toBe(201);
    expect(second.body.session.id).not.toBe(first.body.session.id);
    expect(fake.tables.test_sessions[0]!.status).toBe("expired");
    expect(fake.tables.test_events.map((event) => event.event_type)).toContain("test_expired");
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
