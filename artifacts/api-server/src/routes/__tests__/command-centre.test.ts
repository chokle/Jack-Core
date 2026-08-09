import express, { type Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const identity = vi.hoisted(() => ({
  userId: "pilot-admin",
  email: "admin@example.test",
  name: "Pilot Admin",
  isAdmin: false,
  isPresentation: false,
}));

vi.mock("../../lib/supabase.js", async () => {
  const mocks = await import("../../lib/__tests__/mocks.js");
  return { supabase: { from: mocks.fake.from.bind(mocks.fake) } };
});

vi.mock("../../lib/admin-auth.js", () => ({
  resolveIdentity: vi.fn(async () => (identity.userId ? { ...identity } : null)),
}));

import { fake, resetMocks } from "../../lib/__tests__/mocks.js";
import commandCentreRouter from "../command-centre.js";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const PILOT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ORGANIZATION_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_PILOT_ID = "44444444-4444-4444-8444-444444444444";
const ALERT_ID = "55555555-5555-4555-8555-555555555555";
const EVIDENCE_ID = "66666666-6666-4666-8666-666666666666";
const KNOWLEDGE_ID = "77777777-7777-4777-8777-777777777777";
const USER_ID = "tester-1";

const scopeQuery = `organizationId=${ORGANIZATION_ID}&pilotId=${PILOT_ID}`;
const otherScopeQuery = `organizationId=${OTHER_ORGANIZATION_ID}&pilotId=${OTHER_PILOT_ID}`;

function app(): Express {
  const value = express();
  value.use(express.json());
  value.use((req, _res, next) => {
    (req as never as { log: { error: ReturnType<typeof vi.fn> } }).log = {
      error: vi.fn(),
    };
    next();
  });
  value.use("/api", commandCentreRouter);
  return value;
}

beforeEach(() => {
  resetMocks();
  Object.assign(identity, { userId: "pilot-admin", isAdmin: false, isPresentation: false });
  fake.tables.organizations = [
    { id: ORGANIZATION_ID, name: "Allowed Org", status: "active" },
    { id: OTHER_ORGANIZATION_ID, name: "Other Org", status: "active" },
  ];
  fake.tables.pilots = [
    { id: ORGANIZATION_ID, pilot_id: PILOT_ID, name: "Allowed Pilot", status: "active" },
    { id: OTHER_ORGANIZATION_ID, pilot_id: OTHER_PILOT_ID, name: "Other Pilot", status: "active" },
    { id: PILOT_ID, organization_id: ORGANIZATION_ID, name: "Allowed Pilot", status: "active" },
    { id: OTHER_PILOT_ID, organization_id: OTHER_ORGANIZATION_ID, name: "Other Pilot", status: "active" },
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
  ];
  fake.tables.platform_roles = [];
  fake.tables.test_sessions = [];
  fake.tables.test_events = [];
  fake.tables.test_feedback = [];
  fake.tables.activity_ingest_failures = [];
  fake.tables.pilot_health_alerts = [];
  fake.tables.pilot_evidence = [];
  fake.tables.pilot_knowledge_contributions = [];
  fake.tables.pilot_monitor_state = [];
  fake.tables.admin_access_audit = [];
});

describe("Command Centre API", () => {
  describe("Authentication and Authorization", () => {
    it("rejects unauthenticated requests", async () => {
      identity.userId = "";
      const res = await request(app()).get(`/api/pilots/command-centre/monitor?${scopeQuery}`);
      expect(res.status).toBe(401);
    });

    it("rejects requests in presentation mode", async () => {
      identity.isPresentation = true;
      const res = await request(app()).get(`/api/pilots/command-centre/monitor?${scopeQuery}`);
      expect(res.status).toBe(403);
      expect(res.body.error).toContain("presentation mode");
    });

    it("rejects access to unauthorized organization or pilot", async () => {
      const res = await request(app()).get(`/api/pilots/command-centre/monitor?${otherScopeQuery}`);
      expect(res.status).toBe(403);
    });
  });

  describe("Monitor Endpoint", () => {
    it("returns valid response on empty telemetry", async () => {
      const res = await request(app()).get(`/api/pilots/command-centre/monitor?${scopeQuery}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: "healthy",
        stats: {
          activeSessions: 0,
          totalQuestions: 0,
          avgConfidence: 0.85,
          errorRate: 0,
          totalSites: 0,
          activeTrades: 0,
        },
        siteBreakdown: [],
        tradeBreakdown: [],
        roleBreakdown: [],
        recentQuestions: [],
      });
    });

    it("computes aggregates correctly when telemetry exists", async () => {
      const now = new Date().toISOString();
      fake.tables.test_sessions = [
        {
          id: "session-1",
          actor_user_id: USER_ID,
          organization_id: ORGANIZATION_ID,
          pilot_id: PILOT_ID,
          status: "active",
          site: "Site A",
          trade: "Welder",
          role: "Apprentice",
          started_at: now,
          last_activity_at: now,
        },
      ];
      fake.tables.test_events = [
        {
          event_id: "ev-1",
          actor_user_id: USER_ID,
          organization_id: ORGANIZATION_ID,
          pilot_id: PILOT_ID,
          event_type: "ask_jack_completed",
          occurred_at: now,
          result: "success",
          metadata: { question: "What is E7018?", confidence: 0.9, site: "Site A", trade: "Welder", role: "Apprentice" },
        },
      ];

      const res = await request(app()).get(`/api/pilots/command-centre/monitor?${scopeQuery}`);
      expect(res.status).toBe(200);
      expect(res.body.stats).toMatchObject({
        activeSessions: 1,
        totalQuestions: 1,
        errorRate: 0,
        totalSites: 1,
        activeTrades: 1,
      });
      expect(res.body.siteBreakdown).toEqual([{ name: "Site A", count: 1, active: 1 }]);
      expect(res.body.recentQuestions).toHaveLength(1);
    });
  });

  describe("Alerts CRUD & Tenant Isolation", () => {
    it("creates an alert and supports response contract wrappers", async () => {
      const res = await request(app())
        .post(`/api/pilots/command-centre/alerts?${scopeQuery}`)
        .send({ title: "High Memory Load", severity: "warning", description: "Node memory usage high" });

      expect(res.status).toBe(201);
      expect(res.body.title).toBe("High Memory Load");
      expect(res.body.alert.title).toBe("High Memory Load");
      expect(res.body.severity).toBe("warning");
      expect(fake.tables.pilot_health_alerts).toHaveLength(1);
    });

    it("acknowledges, resolves, and dismisses an alert", async () => {
      fake.tables.pilot_health_alerts = [
        {
          id: ALERT_ID,
          organization_id: ORGANIZATION_ID,
          pilot_id: PILOT_ID,
          alert_type: "custom",
          severity: "high",
          title: "Test Alert",
          status: "open",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ];

      const ack = await request(app()).patch(`/api/pilots/command-centre/alerts/${ALERT_ID}/acknowledge?${scopeQuery}`);
      expect(ack.status).toBe(200);
      expect(ack.body.status).toBe("acknowledged");

      const res = await request(app()).patch(`/api/pilots/command-centre/alerts/${ALERT_ID}/resolve?${scopeQuery}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("resolved");

      const dis = await request(app()).patch(`/api/pilots/command-centre/alerts/${ALERT_ID}/dismiss?${scopeQuery}`);
      expect(dis.status).toBe(200);
      expect(dis.body.status).toBe("dismissed");
    });

    it("enforces tenant isolation: cross-organization or cross-pilot alert update is rejected", async () => {
      fake.tables.pilot_health_alerts = [
        {
          id: ALERT_ID,
          organization_id: OTHER_ORGANIZATION_ID,
          pilot_id: OTHER_PILOT_ID,
          alert_type: "custom",
          severity: "high",
          title: "Other Tenant Alert",
          status: "open",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ];

      // Request using allowed scope attempt to touch OTHER tenant's alert ID
      const patch = await request(app())
        .patch(`/api/pilots/command-centre/alerts/${ALERT_ID}?${scopeQuery}`)
        .send({ status: "resolved" });

      expect(patch.status).toBe(404);
      expect(fake.tables.pilot_health_alerts[0].status).toBe("open"); // Must NOT be modified!

      const ack = await request(app()).patch(`/api/pilots/command-centre/alerts/${ALERT_ID}/acknowledge?${scopeQuery}`);
      expect(ack.status).toBe(404);
      expect(fake.tables.pilot_health_alerts[0].status).toBe("open");
    });

    it("auto-detects health alerts", async () => {
      const res = await request(app()).post(`/api/pilots/command-centre/alerts/auto-detect?${scopeQuery}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("created");
      expect(res.body).toHaveProperty("alerts");
    });
  });

  describe("Evidence CRUD & Tenant Isolation", () => {
    it("creates evidence and maps canonical parameters", async () => {
      const res = await request(app())
        .post(`/api/pilots/command-centre/evidence?${scopeQuery}`)
        .send({ type: "observation", summary: "Weld seam verified" });

      expect(res.status).toBe(201);
      expect(res.body.summary).toBe("Weld seam verified");
      expect(res.body.evidence.summary).toBe("Weld seam verified");
      expect(res.body.type).toBe("observation");
    });

    it("validates evidence and handles status mapping", async () => {
      fake.tables.pilot_evidence = [
        {
          id: EVIDENCE_ID,
          organization_id: ORGANIZATION_ID,
          pilot_id: PILOT_ID,
          actor_user_id: USER_ID,
          evidence_type: "metric",
          title: "Evidence 1",
          validation_status: "unvalidated",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ];

      const val = await request(app())
        .patch(`/api/pilots/command-centre/evidence/${EVIDENCE_ID}/validate?${scopeQuery}`)
        .send({ status: "validated" });

      expect(val.status).toBe(200);
      expect(val.body.validationStatus).toBe("validated");

      const rej = await request(app())
        .patch(`/api/pilots/command-centre/evidence/${EVIDENCE_ID}/validate?${scopeQuery}`)
        .send({ status: "invalid" });

      expect(rej.status).toBe(200);
      expect(rej.body.validationStatus).toBe("invalid");
    });

    it("enforces tenant isolation for evidence mutations", async () => {
      fake.tables.pilot_evidence = [
        {
          id: EVIDENCE_ID,
          organization_id: OTHER_ORGANIZATION_ID,
          pilot_id: OTHER_PILOT_ID,
          actor_user_id: USER_ID,
          evidence_type: "metric",
          title: "Other Tenant Evidence",
          validation_status: "unvalidated",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ];

      const patch = await request(app())
        .patch(`/api/pilots/command-centre/evidence/${EVIDENCE_ID}?${scopeQuery}`)
        .send({ description: "Unauthorized edit" });

      expect(patch.status).toBe(404);
      expect(fake.tables.pilot_evidence[0].description).toBeUndefined();

      const val = await request(app())
        .patch(`/api/pilots/command-centre/evidence/${EVIDENCE_ID}/validate?${scopeQuery}`)
        .send({ status: "validated" });

      expect(val.status).toBe(404);
      expect(fake.tables.pilot_evidence[0].validation_status).toBe("unvalidated");
    });
  });

  describe("Knowledge Contributions", () => {
    it("lists knowledge contributions and provides status filtering compatibility", async () => {
      fake.tables.pilot_knowledge_contributions = [
        {
          id: KNOWLEDGE_ID,
          organization_id: ORGANIZATION_ID,
          pilot_id: PILOT_ID,
          actor_user_id: USER_ID,
          title: "Root Pass Technique",
          body: "Keep tight arc length",
          validation_status: "accepted",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ];

      const res = await request(app()).get(`/api/pilots/command-centre/knowledge?${scopeQuery}&status=approved`);
      expect(res.status).toBe(200);
      expect(res.body.contributions).toHaveLength(1);
      expect(res.body.contributions[0]).toMatchObject({
        title: "Root Pass Technique",
        status: "approved",
        validationStatus: "accepted",
      });
    });
  });
});
