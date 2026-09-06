import { z } from "zod";

export const OperationalScopeSchema = z
  .object({
    userId: z.string().min(1),
    organizationId: z.string().min(1).nullable(),
    siteId: z.string().min(1).nullable(),
  })
  .strict();
export type OperationalScope = z.infer<typeof OperationalScopeSchema>;

const connectivity = z.enum(["online", "degraded", "OTG", "reconnecting"]);
const authority = z.enum([
  "allowed",
  "confirmation_required",
  "denied",
  "escalate",
]);
const confidence = z.enum(["normal", "uncertain", "safety_sensitive"]);
const crew = z.enum(["present", "moving", "missing_heartbeat", "alone"]);
const priority = z.enum(["normal", "urgent", "safety"]);
const agentStatus = z.enum([
  "active",
  "waiting",
  "interrupted",
  "failed",
  "recovered",
]);
const base = {
  version: z.literal(1),
  id: z.string().min(1),
  sequence: z.number().int().positive(),
  scope: OperationalScopeSchema,
  audience: z.literal("field"),
  occurredAt: z.string().datetime().default("1970-01-01T00:00:00.000Z"),
  source: z
    .enum([
      "jack",
      "voice",
      "crew_adapter",
      "agent_runtime",
      "authority",
      "ingestion",
    ])
    .default("jack"),
  severity: z.enum(["normal", "urgent", "safety"]).default("normal"),
  sessionId: z.string().min(1).max(128).nullable().default(null),
  crewId: z.string().min(1).max(128).nullable().default(null),
  correlationId: z.string().min(1).max(128).nullable().default(null),
};
const empty = z.object({}).strict();
const event = <T extends string, P extends z.ZodRawShape>(
  type: T,
  payload: P,
) =>
  z
    .object({
      ...base,
      type: z.literal(type),
      payload: z.object(payload).strict(),
    })
    .strict();
const task = <T extends string>(type: T) =>
  z
    .object({
      ...base,
      type: z.literal(type),
      taskId: z.string().min(1),
      payload: empty,
    })
    .strict();

/** Core-produced events only. Client input must first pass scoped authorization. */
export const OperationalEventSchema = z.discriminatedUnion("type", [
  event("voice.listening.started", {}),
  event("voice.listening.stopped", {}),
  event("intent.resolved", {}),
  task("task.dispatched"),
  task("task.progress"),
  task("task.blocked"),
  task("task.interrupted"),
  task("task.completed"),
  task("task.failed"),
  task("task.recovered"),
  event("crew.heartbeat.missed", {}),
  event("crew.otg.entered", {}),
  event("crew.otg.exited", {}),
  event("safety.alert", {}),
  event("safety.resolved", {}),
  event("authority.confirmation_required", {}),
  event("authority.denied", {}),
  event("authority.escalated", {}),
  event("authority.resolved", {}),
  event("connectivity.changed", { connectivity }),
  event("confidence.changed", { confidence }),
  event("crew.awareness.changed", { crewAwareness: crew }),
  event("priority.changed", { priority }),
  event("state.acknowledged", {}),
  event("state.reset", {}),
  z
    .object({
      ...base,
      audience: z.literal("internal"),
      type: z.literal("agent.status.internal"),
      payload: z
        .object({ agentId: z.string().min(1), status: agentStatus })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      audience: z.literal("internal"),
      type: z.literal("agent.task.changed"),
      taskId: z.string().min(1).max(128),
      payload: z
        .object({
          agentId: z.string().min(1).max(128),
          ownerId: z.string().min(1).max(128),
          status: z.enum([
            "queued",
            "running",
            "blocked",
            "interrupted",
            "failed",
            "recovered",
            "completed",
          ]),
          handoffTo: z.string().min(1).max(128).nullable(),
          modelRoute: z.string().min(1).max(128).nullable(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      audience: z.literal("internal"),
      type: z.literal("agent.health.changed"),
      payload: z
        .object({
          agentId: z.string().min(1).max(128),
          health: z.enum(["healthy", "degraded", "unavailable"]),
        })
        .strict(),
    })
    .strict(),
]);
export type OperationalEvent = z.infer<typeof OperationalEventSchema>;
export type OperationalEventInput = z.input<typeof OperationalEventSchema>;
export type OperationalLifecycle =
  | "idle"
  | "listening"
  | "interpreting"
  | "dispatching"
  | "working"
  | "blocked"
  | "completed"
  | "acknowledged";
export const FieldOperationalStateSchema = z.object({
  scope: OperationalScopeSchema,
  lifecycle: z.enum([
    "idle",
    "listening",
    "interpreting",
    "dispatching",
    "working",
    "blocked",
    "completed",
    "acknowledged",
  ]),
  connectivity,
  authority,
  confidence,
  crewAwareness: crew,
  priority,
  crewObserved: z.boolean(),
  connectivityObserved: z.boolean(),
  taskId: z.string().min(1).nullable(),
  lastSequence: z.number().int().nonnegative(),
  safetyAlert: z.boolean(),
});
export type FieldOperationalState = z.infer<typeof FieldOperationalStateSchema>;
export interface OperationalState extends FieldOperationalState {
  /** Global sequence is hidden from field consumers, including gaps from internal events. */
  lastEventSequence: number;
  lastEventId: string | null;
  taskTerminal: boolean;
  taskRecoverable: boolean;
  internalAgents: Record<string, { status: z.infer<typeof agentStatus> }>;
  tasks: Record<
    string,
    { status: string; updatedAt: string; recoveries: number }
  >;
  internalTasks: Record<
    string,
    {
      agentId: string;
      ownerId: string;
      status: string;
      updatedAt: string;
      recoveries: number;
      handoffTo: string | null;
      modelRoute: string | null;
    }
  >;
  agentHealth: Record<string, "healthy" | "degraded" | "unavailable">;
  agentFailures: Record<string, number>;
  connectivitySince: string | null;
}
export function createOperationalState(
  scope: OperationalScope,
): OperationalState {
  return {
    scope: OperationalScopeSchema.parse(scope),
    lifecycle: "idle",
    connectivity: "degraded",
    crewObserved: false,
    connectivityObserved: false,
    authority: "allowed",
    confidence: "normal",
    crewAwareness: "alone",
    priority: "normal",
    taskId: null,
    lastSequence: 0,
    safetyAlert: false,
    lastEventSequence: 0,
    lastEventId: null,
    taskTerminal: false,
    taskRecoverable: false,
    internalAgents: {},
    tasks: {},
    internalTasks: {},
    agentHealth: {},
    agentFailures: {},
    connectivitySince: null,
  };
}

/** Pure, immutable reduction. Replays, scope mismatch and obsolete task updates are ignored. */
export function reduceOperationalEvent(
  state: OperationalState,
  input: OperationalEvent,
): OperationalState {
  const parsed = OperationalEventSchema.safeParse(input);
  if (!parsed.success) return state;
  const e = parsed.data;
  if (
    e.sequence <= state.lastEventSequence ||
    e.id === state.lastEventId ||
    e.scope.userId !== state.scope.userId ||
    e.scope.organizationId !== state.scope.organizationId ||
    e.scope.siteId !== state.scope.siteId
  )
    return state;
  // Concurrent Jack requests keep their own task feedback without replacing the
  // foreground lifecycle. Unknown/terminal old tasks cannot be resurrected.
  if (
    "taskId" in e &&
    e.audience === "field" &&
    e.type !== "task.dispatched" &&
    e.taskId !== state.taskId
  ) {
    const prior = state.tasks[e.taskId];
    if (
      !prior ||
      prior.status === "completed" ||
      (prior.status === "failed" && e.type !== "task.recovered")
    )
      return state;
    return {
      ...state,
      lastEventSequence: e.sequence,
      lastEventId: e.id,
      lastSequence: state.lastSequence + 1,
      tasks: {
        ...state.tasks,
        [e.taskId]: {
          status: e.type.slice(5),
          updatedAt: e.occurredAt,
          recoveries: prior.recoveries + (e.type === "task.recovered" ? 1 : 0),
        },
      },
    };
  }
  if (
    "taskId" in e &&
    e.audience === "field" &&
    e.type !== "task.dispatched" &&
    (e.taskId !== state.taskId ||
      (state.taskTerminal && e.type !== "task.recovered"))
  )
    return state;
  if (e.type === "task.recovered" && !state.taskRecoverable) return state;
  if (e.type === "task.dispatched" && e.taskId === state.taskId) return state;
  if (e.type === "voice.listening.stopped" && state.lifecycle !== "listening")
    return state;
  if (
    e.type === "state.acknowledged" &&
    !["completed", "blocked"].includes(state.lifecycle)
  )
    return state;
  if (e.type === "agent.status.internal") {
    return {
      ...state,
      lastEventSequence: e.sequence,
      lastEventId: e.id,
      internalAgents: {
        ...state.internalAgents,
        [e.payload.agentId]: { status: e.payload.status },
      },
      agentFailures: {
        ...state.agentFailures,
        [e.payload.agentId]:
          (state.agentFailures[e.payload.agentId] ?? 0) +
          (e.payload.status === "failed" ? 1 : 0),
      },
    };
  }
  if (e.type === "agent.task.changed") {
    const previous = state.internalTasks[e.taskId];
    return {
      ...state,
      lastEventSequence: e.sequence,
      lastEventId: e.id,
      internalTasks: {
        ...state.internalTasks,
        [e.taskId]: {
          ...e.payload,
          updatedAt: e.occurredAt,
          recoveries:
            (previous?.recoveries ?? 0) +
            (e.payload.status === "recovered" ? 1 : 0),
        },
      },
    };
  }
  if (e.type === "agent.health.changed")
    return {
      ...state,
      lastEventSequence: e.sequence,
      lastEventId: e.id,
      agentHealth: {
        ...state.agentHealth,
        [e.payload.agentId]: e.payload.health,
      },
    };
  const next = {
    ...state,
    lastEventSequence: e.sequence,
    lastEventId: e.id,
    lastSequence: state.lastSequence + 1,
  };
  if ("taskId" in e)
    next.tasks = {
      ...state.tasks,
      [e.taskId]: {
        status: e.type.slice(5),
        updatedAt: e.occurredAt,
        recoveries:
          (state.tasks[e.taskId]?.recoveries ?? 0) +
          (e.type === "task.recovered" ? 1 : 0),
      },
    };
  switch (e.type) {
    case "voice.listening.started":
      next.lifecycle = "listening";
      break;
    case "voice.listening.stopped":
      next.lifecycle = "interpreting";
      break;
    case "intent.resolved":
      next.lifecycle = "dispatching";
      break;
    case "task.dispatched":
      next.taskId = e.taskId;
      next.taskTerminal = false;
      next.taskRecoverable = false;
      next.lifecycle = "dispatching";
      break;
    case "task.progress":
    case "task.recovered":
      next.lifecycle = "working";
      next.taskTerminal = false;
      next.taskRecoverable = false;
      break;
    case "task.blocked":
    case "task.interrupted":
      next.lifecycle = "blocked";
      next.taskRecoverable = true;
      break;
    case "task.failed":
      next.lifecycle = "blocked";
      next.taskTerminal = true;
      next.taskRecoverable = true;
      break;
    case "task.completed":
      next.lifecycle = "completed";
      next.taskTerminal = true;
      next.taskRecoverable = false;
      break;
    case "crew.heartbeat.missed":
      next.crewAwareness = "missing_heartbeat";
      next.crewObserved = true;
      break;
    case "crew.otg.entered":
      next.connectivity = "OTG";
      next.connectivityObserved = true;
      break;
    case "crew.otg.exited":
      next.connectivity = "reconnecting";
      next.connectivityObserved = true;
      break;
    case "safety.alert":
      next.safetyAlert = true;
      break;
    case "safety.resolved":
      next.safetyAlert = false;
      next.priority = "normal";
      next.confidence = "normal";
      break;
    case "authority.confirmation_required":
      next.authority = "confirmation_required";
      break;
    case "authority.denied":
      next.authority = "denied";
      break;
    case "authority.escalated":
      next.authority = "escalate";
      break;
    case "authority.resolved":
      next.authority = "allowed";
      break;
    case "connectivity.changed":
      next.connectivity = e.payload.connectivity;
      next.connectivityObserved = true;
      break;
    case "confidence.changed":
      next.confidence = e.payload.confidence;
      break;
    case "crew.awareness.changed":
      next.crewAwareness = e.payload.crewAwareness;
      next.crewObserved = true;
      break;
    case "priority.changed":
      next.priority = e.payload.priority;
      break;
    case "state.acknowledged":
      next.lifecycle = "acknowledged";
      break;
    case "state.reset":
      next.lifecycle = "idle";
      next.taskId = null;
      next.taskTerminal = false;
      next.taskRecoverable = false;
      break;
  }
  if (next.safetyAlert) {
    next.priority = "safety";
    next.confidence = "safety_sensitive";
  }
  if (
    next.connectivity !== state.connectivity ||
    (next.connectivityObserved && !state.connectivityObserved)
  )
    next.connectivitySince = e.occurredAt;
  if (next.safetyAlert || next.authority !== "allowed")
    next.lifecycle = "blocked";
  return next;
}

/** An explicit allowlist: no agent metadata, internal event IDs, or arbitrary text. */
export function projectFieldState(
  state: OperationalState,
): FieldOperationalState {
  return {
    scope: {
      userId: state.scope.userId,
      organizationId: state.scope.organizationId,
      siteId: state.scope.siteId,
    },
    lifecycle: state.lifecycle,
    connectivity: state.connectivity,
    authority: state.authority,
    confidence: state.confidence,
    crewAwareness: state.crewAwareness,
    priority: state.priority,
    taskId: state.taskId,
    lastSequence: state.lastSequence,
    safetyAlert: state.safetyAlert,
    crewObserved: state.crewObserved,
    connectivityObserved: state.connectivityObserved,
  };
}
