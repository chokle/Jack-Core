import { describe, expect, it } from "vitest";
import {
  createOperationalState,
  FieldOperationalStateSchema,
  OperationalEventSchema,
  projectFieldState,
  reduceOperationalEvent,
  type OperationalEvent,
} from "@workspace/api-zod";

const scope = { userId: "u1", organizationId: "o1", siteId: "s1" };
const makeEvent = (
  type: OperationalEvent["type"],
  sequence: number,
  extra = {},
): OperationalEvent =>
  OperationalEventSchema.parse({
    version: 1,
    id: `e${sequence}`,
    sequence,
    scope,
    audience: "field",
    type,
    payload: {},
    ...extra,
  });

describe("canonical operational state", () => {
  it("ignores delayed voice observations but accepts a new listening turn after task completion", () => {
    let state = createOperationalState(scope);
    for (const [index, type] of [
      "task.dispatched",
      "task.progress",
      "task.completed",
    ].entries()) {
      state = reduceOperationalEvent(
        state,
        makeEvent(type as OperationalEvent["type"], index + 1, {
          taskId: "field-task",
          occurredAt: `2026-09-06T12:00:0${index + 1}.000Z`,
        }),
      );
      for (const voiceType of [
        "voice.listening.started",
        "voice.listening.stopped",
      ] as const) {
        expect(
          reduceOperationalEvent(
            state,
            makeEvent(voiceType, 10, {
              occurredAt: "2026-09-06T12:00:00.000Z",
            }),
          ),
        ).toBe(state);
      }
    }
    expect(
      reduceOperationalEvent(
        state,
        makeEvent("voice.listening.started", 11, {
          occurredAt: "2026-09-06T12:00:04.000Z",
        }),
      ).lifecycle,
    ).toBe("listening");
  });
  it("starts without claiming measured connectivity or crew presence", () => {
    expect(createOperationalState(scope)).toMatchObject({
      lifecycle: "idle",
      connectivity: "degraded",
      crewAwareness: "alone",
      crewObserved: false,
      connectivityObserved: false,
    });
  });
  it("reduces the Jack lifecycle deterministically without mutating prior state", () => {
    const initial = createOperationalState(scope);
    const types = [
      "voice.listening.started",
      "voice.listening.stopped",
      "intent.resolved",
      "task.dispatched",
      "task.progress",
      "task.completed",
      "state.acknowledged",
    ] as const;
    const expected = [
      "listening",
      "interpreting",
      "dispatching",
      "dispatching",
      "working",
      "completed",
      "acknowledged",
    ];
    let state = initial;
    types.forEach((type, i) => {
      const e = makeEvent(
        type,
        i + 1,
        type.startsWith("task.") ? { taskId: "field-task" } : {},
      );
      expect(reduceOperationalEvent(state, e)).toEqual(
        reduceOperationalEvent(state, e),
      );
      state = reduceOperationalEvent(state, e);
      expect(state.lifecycle).toBe(expected[i]);
    });
    expect(initial.lifecycle).toBe("idle");
  });
  it("ignores stale and duplicate events and all scope mismatches", () => {
    const event = makeEvent("voice.listening.started", 3);
    const state = reduceOperationalEvent(createOperationalState(scope), event);
    expect(reduceOperationalEvent(state, event)).toBe(state);
    expect(
      reduceOperationalEvent(state, makeEvent("voice.listening.stopped", 2)),
    ).toBe(state);
    for (const key of ["userId", "organizationId", "siteId"]) {
      expect(
        reduceOperationalEvent(
          state,
          makeEvent("voice.listening.stopped", 4, {
            scope: { ...scope, [key]: "different" },
          }),
        ),
      ).toBe(state);
    }
  });
  it("rejects old task updates and supports blocked/interrupted/failed task recovery", () => {
    let state = reduceOperationalEvent(
      createOperationalState(scope),
      makeEvent("task.dispatched", 1, { taskId: "t1" }),
    );
    state = reduceOperationalEvent(
      state,
      makeEvent("task.dispatched", 2, { taskId: "t2" }),
    );
    const concurrent = reduceOperationalEvent(
      state,
      makeEvent("task.completed", 3, { taskId: "t1" }),
    );
    expect(concurrent.taskId).toBe("t2");
    expect(concurrent.lifecycle).toBe(state.lifecycle);
    expect(concurrent.tasks.t1.status).toBe("completed");
    for (const [i, type] of (
      ["task.blocked", "task.interrupted", "task.failed"] as const
    ).entries()) {
      state = reduceOperationalEvent(
        state,
        makeEvent(type, 4 + i, { taskId: "t2" }),
      );
      expect(state.lifecycle).toBe("blocked");
    }
    expect(
      reduceOperationalEvent(
        state,
        makeEvent("task.progress", 7, { taskId: "t2" }),
      ),
    ).toBe(state);
    state = reduceOperationalEvent(
      state,
      makeEvent("task.recovered", 8, { taskId: "t2" }),
    );
    expect(state.lifecycle).toBe("working");
  });
  it("keeps safety and authority gates sticky through acknowledgement, reset and lower priority updates", () => {
    let state = reduceOperationalEvent(
      createOperationalState(scope),
      makeEvent("safety.alert", 1),
    );
    state = reduceOperationalEvent(state, makeEvent("authority.denied", 2));
    state = reduceOperationalEvent(state, makeEvent("state.acknowledged", 3));
    state = reduceOperationalEvent(state, makeEvent("state.reset", 4));
    state = reduceOperationalEvent(
      state,
      makeEvent("priority.changed", 5, { payload: { priority: "normal" } }),
    );
    state = reduceOperationalEvent(
      state,
      makeEvent("confidence.changed", 6, { payload: { confidence: "normal" } }),
    );
    expect(state).toMatchObject({
      lifecycle: "blocked",
      authority: "denied",
      priority: "safety",
      confidence: "safety_sensitive",
    });
    state = reduceOperationalEvent(state, makeEvent("safety.resolved", 7));
    expect(state).toMatchObject({
      lifecycle: "blocked",
      authority: "denied",
      safetyAlert: false,
    });
    state = reduceOperationalEvent(state, makeEvent("authority.resolved", 8));
    state = reduceOperationalEvent(state, makeEvent("state.acknowledged", 9));
    expect(state.lifecycle).toBe("acknowledged");
  });
  it("transitions OTG through reconnecting and records missing heartbeat", () => {
    let state = reduceOperationalEvent(
      createOperationalState(scope),
      makeEvent("crew.otg.entered", 1),
    );
    expect(state.connectivity).toBe("OTG");
    expect(state.connectivityObserved).toBe(true);
    expect(state.crewObserved).toBe(false);
    state = reduceOperationalEvent(state, makeEvent("crew.otg.exited", 2));
    expect(state.connectivity).toBe("reconnecting");
    state = reduceOperationalEvent(
      state,
      makeEvent("crew.heartbeat.missed", 3),
    );
    expect(state.crewAwareness).toBe("missing_heartbeat");
    expect(state.crewObserved).toBe(true);
  });
  it("rejects invalid lifecycle transitions and recovery of completed tasks", () => {
    const idle = createOperationalState(scope);
    expect(
      reduceOperationalEvent(idle, makeEvent("voice.listening.stopped", 1)),
    ).toBe(idle);
    expect(
      reduceOperationalEvent(idle, makeEvent("state.acknowledged", 1)),
    ).toBe(idle);
    let state = reduceOperationalEvent(
      idle,
      makeEvent("task.dispatched", 1, { taskId: "t1" }),
    );
    expect(
      reduceOperationalEvent(
        state,
        makeEvent("task.dispatched", 2, { taskId: "t1" }),
      ),
    ).toBe(state);
    state = reduceOperationalEvent(
      state,
      makeEvent("task.progress", 2, { taskId: "t1" }),
    );
    expect(
      reduceOperationalEvent(state, makeEvent("state.acknowledged", 3)),
    ).toBe(state);
    state = reduceOperationalEvent(
      state,
      makeEvent("task.completed", 3, { taskId: "t1" }),
    );
    state = reduceOperationalEvent(state, makeEvent("safety.alert", 4));
    expect(
      reduceOperationalEvent(
        state,
        makeEvent("task.recovered", 5, { taskId: "t1" }),
      ),
    ).toBe(state);
  });
  it("supports every cross-cutting state value through typed events", () => {
    let state = createOperationalState(scope);
    let sequence = 0;
    const dimensions = [
      [
        "connectivity.changed",
        "connectivity",
        ["online", "degraded", "OTG", "reconnecting"],
      ],
      [
        "confidence.changed",
        "confidence",
        ["normal", "uncertain", "safety_sensitive"],
      ],
      [
        "crew.awareness.changed",
        "crewAwareness",
        ["present", "moving", "missing_heartbeat", "alone"],
      ],
      ["priority.changed", "priority", ["normal", "urgent", "safety"]],
    ] as const;
    for (const [type, key, values] of dimensions)
      for (const value of values) {
        state = reduceOperationalEvent(
          state,
          makeEvent(type, ++sequence, { payload: { [key]: value } }),
        );
        expect(state[key]).toBe(value);
        if (key === "connectivity")
          expect(state.connectivityObserved).toBe(true);
        if (key === "crewAwareness") expect(state.crewObserved).toBe(true);
      }
    for (const [type, expected] of [
      ["authority.confirmation_required", "confirmation_required"],
      ["authority.denied", "denied"],
      ["authority.escalated", "escalate"],
      ["authority.resolved", "allowed"],
    ] as const) {
      state = reduceOperationalEvent(state, makeEvent(type, ++sequence));
      expect(state.authority).toBe(expected);
    }
  });
  it("never exposes internal agent updates through field projection", () => {
    const initial = createOperationalState(scope);
    let state = initial;
    for (const [i, status] of (
      ["active", "waiting", "interrupted", "failed", "recovered"] as const
    ).entries()) {
      state = reduceOperationalEvent(
        state,
        makeEvent("agent.status.internal", i + 1, {
          audience: "internal",
          payload: { agentId: "Dex", status },
        }),
      );
      expect(projectFieldState(state)).toEqual(projectFieldState(initial));
      expect(state.internalAgents.Dex.status).toBe(status);
    }
    expect(FieldOperationalStateSchema.parse(state)).toEqual(
      projectFieldState(state),
    );
    const projected = projectFieldState(state);
    projected.scope.userId = "changed";
    expect(state.scope.userId).toBe("u1");
  });
  it("rejects invalid versions, audiences, unknown text, and unscoped task events", () => {
    const event = makeEvent("voice.listening.started", 1);
    for (const extra of [
      { version: 2 },
      { sequence: 0 },
      { audience: "internal" },
      { message: "Dex" },
      { payload: { internalAgent: "Dex" } },
      { type: "task.progress" },
    ]) {
      expect(
        OperationalEventSchema.safeParse({ ...event, ...extra }).success,
      ).toBe(false);
    }
    expect(
      OperationalEventSchema.safeParse({
        ...event,
        type: "agent.status.internal",
        payload: { agentId: "Dex", status: "active" },
      }).success,
    ).toBe(false);
    expect(
      reduceOperationalEvent(createOperationalState(scope), {
        ...event,
        version: 2,
      } as unknown as OperationalEvent).lastSequence,
    ).toBe(0);
  });
});
