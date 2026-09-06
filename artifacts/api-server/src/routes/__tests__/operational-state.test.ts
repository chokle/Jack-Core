import express, { type Response } from "express";
import { EventEmitter } from "node:events";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
const { getAuth, getUser } = vi.hoisted(() => ({
  getAuth: vi.fn(),
  getUser: vi.fn(),
}));
vi.mock("@clerk/express", () => ({
  getAuth,
  clerkClient: { users: { getUser } },
}));
vi.mock("../../lib/activity-telemetry.js", () => ({
  activityDb: {},
  resolveActiveTesterScope: vi.fn(async () => ({ scope: null })),
  latestConsent: vi.fn(),
  currentConsentGranted: vi.fn(() => false),
  authorizeReportScope: vi.fn(async () => ({ allowed: false })),
  auditReportAccess: vi.fn(async () => {}),
  requestIdentifier: vi.fn(() => "test"),
}));
import router, { guardJackAgentBoundary } from "../operational-state.js";
import {
  operationalState,
  personalOperationalScope,
  OperationalStateStore,
  observeJackTask,
  type EventInput,
} from "../../lib/operational-state.js";
import { authorizeAgentPermission } from "../../lib/agent-authorization.js";
import { projectFieldState } from "@workspace/api-zod";
import { operationalBus } from "../../lib/operational-bus.js";

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.userId = "field";
  next();
});
app.use(router);
app.post("/chat", guardJackAgentBoundary, (_req, res) =>
  res.json({ answer: "Jack" }),
);
app.post("/observe", (req, res) => {
  const task = observeJackTask(req.userId!, res);
  if (req.body.blocked) task.authorityBlocked();
  res.status(req.body.failed ? 500 : 200).json({ ok: true });
});

function role(role: string) {
  getUser.mockResolvedValue({
    primaryEmailAddress: { emailAddress: "worker@example.invalid" },
    emailAddresses: [],
    firstName: null,
    lastName: null,
    publicMetadata: { role },
    unsafeMetadata: { role: "admin" },
  });
}
beforeEach(() => {
  delete process.env.PILOT_AUTH_BYPASS;
  getAuth.mockReturnValue({ userId: "field" });
  role("field");
});

const permissions = [
  "agent.command.start",
  "agent.command.reprioritize",
  "agent.interrupt.task",
  "agent.dispatch.worker",
  "agent.model.route",
  "agent.status.internal",
];
describe("internal agent boundary", () => {
  it("timestamps task observations before waiting for earlier journal writes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-09-06T12:00:00.000Z"));
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const events: EventInput[] = [];
      const response = Object.assign(new EventEmitter(), {
        statusCode: 200,
        writableFinished: true,
      });
      observeJackTask(
        "field",
        response as unknown as Response,
        async (event) => {
          events.push(event);
          if (events.length === 1) await blocked;
        },
      );
      await Promise.resolve();
      vi.setSystemTime(new Date("2026-09-06T12:00:02.000Z"));
      response.emit("finish");
      vi.setSystemTime(new Date("2026-09-06T12:00:10.000Z"));
      release();
      await vi.waitFor(() => expect(events).toHaveLength(4));
      expect(events.map((event) => event.occurredAt)).toEqual([
        "2026-09-06T12:00:00.000Z",
        "2026-09-06T12:00:00.000Z",
        "2026-09-06T12:00:00.000Z",
        "2026-09-06T12:00:02.000Z",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
  for (const humanRole of ["field", "foreman", "superintendent"]) {
    it.each(permissions)(
      `${humanRole} cannot invoke %s, including voice or spoofed admin fields`,
      async (permission) => {
        role(humanRole);
        for (const channel of ["voice", "command-centre"]) {
          const response = await request(app)
            .post("/admin/agents/commands")
            .send({ permission, agentId: "Dex", channel, isAdmin: true });
          expect(response.status).toBe(403);
        }
        expect((await request(app).get("/admin/agents/state")).status).toBe(
          403,
        );
      },
    );
  }
  it.each(permissions.filter((p) => p !== "agent.status.internal"))(
    "admin is authorized for %s but no executor is falsely reported",
    async (permission) => {
      role("admin");
      expect((await request(app).get("/admin/agents/state")).status).toBe(200);
      for (const channel of ["voice", "command-centre"]) {
        const response = await request(app)
          .post("/admin/agents/commands")
          .send({ permission, agentId: "Dex", channel });
        expect(response.status).toBe(501);
        expect(response.body.error).toMatch(/No internal agent executor/);
      }
    },
  );
  it("denies anonymous, unavailable, restricted and unknown permissions", async () => {
    getAuth.mockReturnValue(null);
    expect((await request(app).get("/operational/state")).status).toBe(401);
    getAuth.mockReturnValue({ userId: "field" });
    getUser.mockRejectedValue(new Error("unavailable"));
    expect((await request(app).get("/admin/agents/state")).status).toBe(403);
    expect(
      authorizeAgentPermission(
        {
          userId: "a",
          email: null,
          name: null,
          isAdmin: true,
          classification: "restricted",
          isPresentation: true,
        },
        "agent.command.start",
      ),
    ).toBe(false);
    role("admin");
    expect(
      (
        await request(app)
          .post("/admin/agents/commands")
          .send({ permission: "agent.root", agentId: "Dex", channel: "voice" })
      ).status,
    ).toBe(403);
  });
  it.each([
    "Dex",
    "Foreman Agent",
    "Sweeper",
    "Journeyman Agent",
    "internal agent",
  ])("blocks addressing %s through chat before execution", async (agent) => {
    expect(
      (
        await request(app)
          .post("/chat")
          .send({ message: `Ask ${agent} to start` })
      ).status,
    ).toBe(403);
  });
  it("keeps normal Jack and human foreman questions working; structured targets are denied", async () => {
    expect(
      (
        await request(app)
          .post("/chat")
          .send({ message: "What should I ask my foreman?" })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .post("/chat")
          .send({ message: "hello", agentId: "future-worker" })
      ).status,
    ).toBe(403);
    role("admin");
    expect(
      (await request(app).post("/chat").send({ message: "Dex start" })).status,
    ).toBe(409);
  });
  it.each([
    "What is an Android DEX file?",
    "My coworker Dex found a damaged ladder. What should we do?",
    "Dex is my coworker. Can you explain this citation?",
    "How do I safely use a floor sweeper?",
    "What are internal AI agents?",
  ])(
    "allows ordinary field questions mentioning names: %s",
    async (message) => {
      expect((await request(app).post("/chat").send({ message })).status).toBe(
        200,
      );
    },
  );
  it.each([
    "Dex, start the task",
    "Hey Dex please stop",
    "Jack interrupt agent Dex",
    "Jack run agent Dex",
    "Tell the Foreman Agent to dispatch Sweeper",
    "Ask Journeyman Agent to report status",
  ])("still denies explicit internal addressing: %s", async (message) => {
    expect((await request(app).post("/chat").send({ message })).status).toBe(
      403,
    );
  });
});

describe("field operational read and observations", () => {
  it("does not serve a known incomplete event history as current field state", async () => {
    const read = vi.spyOn(operationalBus, "read").mockResolvedValueOnce({
      state: operationalState.read(personalOperationalScope("field")),
      history: [],
      durability: "unavailable",
    });
    try {
      expect((await request(app).get("/operational/state")).status).toBe(503);
    } finally {
      read.mockRestore();
    }
  });
  it("mirrors one state in the privileged admin projection and the field projection", async () => {
    operationalState.publish(personalOperationalScope("field"), {
      type: "agent.status.internal",
      audience: "internal",
      payload: { agentId: "Dex", status: "active" },
    });
    role("admin");
    const admin = await request(app).get("/admin/agents/state");
    const field = await request(app).get("/operational/state");
    expect(admin.status).toBe(200);
    expect(admin.body.state.internalAgents.Dex.status).toBe("active");
    expect(
      admin.body.history.some(
        (event: { type: string }) => event.type === "agent.status.internal",
      ),
    ).toBe(true);
    expect(projectFieldState(admin.body.state)).toEqual(field.body);
    expect(field.body.internalAgents).toBeUndefined();
  });
  it("projects state without internal agents or sequence side channels", async () => {
    const before = (await request(app).get("/operational/state")).body;
    operationalState.publish(personalOperationalScope("field"), {
      type: "agent.status.internal",
      audience: "internal",
      payload: { agentId: "Dex", status: "active" },
    });
    const after = await request(app).get("/operational/state");
    expect(after.status).toBe(200);
    expect(after.body).toEqual(before);
    expect(JSON.stringify(after.body)).not.toMatch(
      /Dex|internalAgents|lastEvent/,
    );
    expect(after.headers["cache-control"]).toBe("no-store");
  });
  it("rejects user/org/site selectors and arbitrary event injection", async () => {
    for (const selector of ["userId", "organizationId", "siteId"]) {
      expect(
        (await request(app).get(`/operational/state?${selector}=other`)).status,
      ).toBe(400);
      role("admin");
      expect([400, 403]).toContain(
        (await request(app).get(`/admin/agents/state?${selector}=other`))
          .status,
      );
    }
    expect(
      (
        await request(app)
          .post("/operational/voice")
          .send({ type: "authority.resolved" })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post("/operational/voice")
          .send({ type: "voice.listening.started", scope: { userId: "other" } })
      ).status,
    ).toBe(400);
  });
  it("allows voice observations without granting agent capabilities", async () => {
    const response = await request(app)
      .post("/operational/voice")
      .send({ type: "voice.listening.started" });
    expect(response.status).toBe(200);
    expect(response.body.lifecycle).toBe("listening");
    expect((await request(app).get("/admin/agents/state")).status).toBe(403);
  });
  it("tracks completed and failed requests and preserves real authority blocks", async () => {
    await request(app).post("/observe").send({});
    expect(
      operationalState.readField(personalOperationalScope("field")).lifecycle,
    ).toBe("completed");
    await request(app).post("/observe").send({ failed: true });
    expect(
      operationalState.readField(personalOperationalScope("field")).lifecycle,
    ).toBe("blocked");
    await request(app).post("/observe").send({ blocked: true });
    expect(
      operationalState.readField(personalOperationalScope("field")),
    ).toMatchObject({
      lifecycle: "blocked",
      authority: "denied",
      safetyAlert: true,
    });
  });
  it("isolates exact scopes, protects stored objects and expires ephemeral data", () => {
    let time = 0;
    const store = new OperationalStateStore(() => time);
    const scope = personalOperationalScope("a");
    store.publish(scope, {
      type: "voice.listening.started",
      audience: "field",
      payload: {},
    });
    expect(store.readField(personalOperationalScope("b")).lifecycle).toBe(
      "idle",
    );
    expect(
      store.readField({ ...scope, organizationId: "org", siteId: "site" })
        .lifecycle,
    ).toBe("idle");
    store.read(scope).scope.userId = "mutated";
    expect(store.read(scope).scope.userId).toBe("a");
    time += 31 * 60_000;
    expect(store.readField(scope).lifecycle).toBe("idle");
  });
});
