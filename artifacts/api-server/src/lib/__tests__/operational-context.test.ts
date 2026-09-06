import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request } from "express";
import type { CallerIdentity } from "../admin-auth.js";
const mocks = vi.hoisted(() => ({
  membership: vi.fn(),
  consent: vi.fn(),
  report: vi.fn(),
  audit: vi.fn(),
  from: vi.fn(),
}));
vi.mock("../activity-telemetry.js", () => ({
  activityDb: { from: mocks.from },
  resolveActiveTesterScope: mocks.membership,
  latestConsent: mocks.consent,
  currentConsentGranted: (c: { state: string } | null) =>
    c?.state === "granted",
  authorizeReportScope: mocks.report,
  auditReportAccess: mocks.audit,
  requestIdentifier: () => "request",
}));
import {
  resolveOperationalContext,
  SupabaseOperationalJournal,
  OperationalBus,
} from "../operational-bus.js";
import {
  OperationalEventSchema,
  createOperationalState,
  reduceOperationalEvent,
  operationalAlerts,
  projectCommandCentre,
  projectFieldState,
  type OperationalEvent,
} from "@workspace/api-zod";
const org = "11111111-1111-4111-8111-111111111111",
  pilot = "22222222-2222-4222-8222-222222222222",
  session = "33333333-3333-4333-8333-333333333333";
const scope = { userId: "u", organizationId: org, siteId: null };
const consent = {
  id: "grant",
  state: "granted" as const,
  privacyNoticeVersion: "v",
  consentVersion: "v",
};
const context = { scope, sessionId: session, pilotId: pilot, consent };
const identity: CallerIdentity = {
  userId: "u",
  email: "u@example.invalid",
  name: null,
  isAdmin: true,
  isPresentation: false,
  classification: "resolved",
};
const req = { headers: {}, userId: "u" } as Request;
let calls: Array<[string, ...unknown[]]>;
let rows: unknown[];
beforeEach(() => {
  calls = [];
  rows = [{ id: session }];
  vi.clearAllMocks();
  mocks.membership.mockResolvedValue({
    scope: { organizationId: org, pilotId: pilot },
  });
  mocks.consent.mockResolvedValue(consent);
  mocks.report.mockResolvedValue({ allowed: false });
  mocks.audit.mockResolvedValue(undefined);
  mocks.from.mockImplementation((table: string) => {
    const query: Record<string, unknown> = {};
    for (const method of [
      "select",
      "eq",
      "is",
      "gt",
      "order",
      "range",
      "limit",
      "insert",
    ])
      query[method] = (...args: unknown[]) => {
        calls.push([method, ...args]);
        return query;
      };
    query.then = (done: (r: unknown) => unknown) =>
      Promise.resolve({ data: rows, error: null }).then(done);
    calls.push(["from", table]);
    return query;
  });
});
describe("operational scope and journal boundary", () => {
  it("uses exact server membership, actor, session and consent predicates", async () => {
    expect(await resolveOperationalContext(req, identity)).toEqual(context);
    for (const [key, value] of [
      ["actor_user_id", "u"],
      ["organization_id", org],
      ["pilot_id", pilot],
      ["telemetry_consent_id", "grant"],
    ])
      expect(calls).toContainEqual(["eq", key, value]);
  });
  it("requires an existing report grant for another actor and denies site/crew expansion", async () => {
    await expect(
      resolveOperationalContext(req, identity, {
        userId: "other",
        organizationId: org,
        pilotId: pilot,
      }),
    ).rejects.toThrow(/authorized/);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "denied" }),
    );
    mocks.report.mockResolvedValue({ allowed: true });
    expect(
      (
        await resolveOperationalContext(req, identity, {
          userId: "other",
          organizationId: org,
          pilotId: pilot,
        })
      ).scope.userId,
    ).toBe("other");
    for (const filters of [{ siteId: "foreign" }, { crewId: "foreign" }])
      await expect(
        resolveOperationalContext(req, identity, filters),
      ).rejects.toThrow(/adapter/);
  });
  it("never infers durable consent and rejects ambiguous sessions", async () => {
    mocks.consent.mockResolvedValue(null);
    expect(
      (await resolveOperationalContext(req, identity)).sessionId,
    ).toBeNull();
    await expect(
      resolveOperationalContext(req, identity, { sessionId: session }),
    ).rejects.toThrow(/consent/);
    mocks.consent.mockResolvedValue(consent);
    rows = [{ id: session }, { id: "ambiguous" }];
    await expect(
      resolveOperationalContext(req, identity, { sessionId: session }),
    ).rejects.toThrow(/unique/);
  });
  it("load binds all tenant predicates and fails closed on corrupted persisted provenance", async () => {
    rows = [
      {
        sequence: 1,
        event: OperationalEventSchema.parse({
          id: "e",
          version: 1,
          sequence: 1,
          scope: { ...scope, userId: "foreign" },
          sessionId: session,
          type: "voice.listening.started",
          audience: "field",
          payload: {},
        }),
      },
    ];
    await expect(
      new SupabaseOperationalJournal().load(context),
    ).rejects.toThrow(/scope/);
    for (const [key, value] of [
      ["actor_user_id", "u"],
      ["organization_id", org],
      ["pilot_id", pilot],
      ["test_session_id", session],
      ["consent_id", "grant"],
    ])
      expect(calls).toContainEqual(["eq", key, value]);
    expect(calls).toContainEqual(["is", "site_id", null]);
    expect(calls).toContainEqual(["is", "crew_id", null]);
  });
  it("does not publish a failed append and exposes ingestion alert from the same bus", async () => {
    let offline = true;
    const bus = new OperationalBus({
      append: async () => {
        if (offline) throw new Error("offline");
      },
      load: async () => [],
    });
    await expect(
      bus.publish(context, {
        type: "safety.alert",
        audience: "field",
        payload: {},
      }),
    ).rejects.toThrow("offline");
    offline = false;
    await bus.publish(context, {
      type: "voice.listening.started",
      audience: "field",
      payload: {},
    });
    const result = await bus.read(context);
    expect(result.history).toEqual([]);
    expect(
      projectCommandCentre(
        result.state,
        result.history,
        {},
        Date.now(),
        result.durability,
      ).alerts,
    ).toContainEqual({
      code: "event_ingestion_failed",
      severity: "urgent",
      subjectId: null,
    });
  });
});

describe("shared Command Centre diagnostics", () => {
  it("derives all alerts and filters from canonical state without exposing internals to HUD", () => {
    let state = createOperationalState(scope);
    let sequence = 0;
    const history: OperationalEvent[] = [];
    const emit = (type: string, payload = {}, extra = {}) => {
      const e = OperationalEventSchema.parse({
        version: 1,
        id: `e${++sequence}`,
        sequence,
        scope,
        sessionId: session,
        occurredAt: "2026-09-06T00:00:00.000Z",
        type,
        payload,
        audience: type.startsWith("agent.") ? "internal" : "field",
        ...extra,
      });
      history.push(e);
      state = reduceOperationalEvent(state, e);
    };
    emit("crew.heartbeat.missed");
    emit("crew.otg.entered");
    emit("authority.escalated");
    emit("safety.alert");
    for (let i = 0; i < 3; i++)
      emit("agent.status.internal", { agentId: "Dex", status: "failed" });
    emit("agent.health.changed", { agentId: "Dex", health: "degraded" });
    for (let i = 0; i < 3; i++)
      emit(
        "agent.task.changed",
        {
          agentId: "Dex",
          ownerId: "Foreman",
          status: "recovered",
          handoffTo: "Sweeper",
          modelRoute: "approved",
        },
        { taskId: "private" },
      );
    const now = Date.parse("2026-09-06T01:00:00.000Z");
    const codes = operationalAlerts(state, now, false).map((a) => a.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "event_ingestion_failed",
        "missed_heartbeat",
        "extended_otg",
        "authority_escalation",
        "safety_sensitive_escalation",
        "repeated_agent_failures",
        "agent_health_degraded",
        "repeated_recovery_loop",
        "stuck_task",
      ]),
    );
    emit("connectivity.changed", { connectivity: "degraded" });
    expect(
      operationalAlerts(state, now).some(
        (a) => a.code === "degraded_connectivity",
      ),
    ).toBe(true);
    const filtered = projectCommandCentre(
      state,
      history,
      { agentId: "Dex", taskStatus: "recovered", connectivity: "degraded" },
      now,
    );
    expect(filtered.history).toHaveLength(3);
    expect(filtered.state).toBe(state);
    expect(JSON.stringify(projectFieldState(state))).not.toMatch(
      /Dex|Foreman|Sweeper|private|approved/,
    );
  });
});
