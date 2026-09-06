import { z } from "zod";
import {
  type OperationalState,
  type OperationalEvent,
} from "./operational-state.js";

export const OperationalFiltersSchema = z
  .object({
    organizationId: z.string().uuid().optional(),
    pilotId: z.string().uuid().optional(),
    siteId: z.string().min(1).max(128).optional(),
    crewId: z.string().min(1).max(128).optional(),
    userId: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,128}$/)
      .optional(),
    sessionId: z.string().uuid().optional(),
    agentId: z.string().min(1).max(128).optional(),
    eventType: z.string().min(1).max(100).optional(),
    severity: z.enum(["normal", "urgent", "safety"]).optional(),
    taskStatus: z
      .enum([
        "queued",
        "running",
        "dispatching",
        "dispatched",
        "progress",
        "blocked",
        "interrupted",
        "failed",
        "recovered",
        "completed",
      ])
      .optional(),
    connectivity: z
      .enum(["online", "degraded", "OTG", "reconnecting"])
      .optional(),
  })
  .strict();
export type OperationalFilters = z.infer<typeof OperationalFiltersSchema>;
export type OperationalAlert = {
  code: string;
  severity: "urgent" | "safety";
  subjectId: string | null;
};

/** Shared deterministic alert projection; no UI implements its own thresholds. */
export function operationalAlerts(
  state: OperationalState,
  now: number,
  ingestionHealthy = true,
): OperationalAlert[] {
  const alerts: OperationalAlert[] = [];
  const add = (
    code: string,
    subjectId: string | null = null,
    severity: "urgent" | "safety" = "urgent",
  ) => alerts.push({ code, subjectId, severity });
  if (!ingestionHealthy) add("event_ingestion_failed");
  if (state.crewObserved && state.crewAwareness === "missing_heartbeat")
    add("missed_heartbeat");
  if (state.connectivityObserved && state.connectivity === "degraded")
    add("degraded_connectivity");
  if (
    state.connectivity === "OTG" &&
    state.connectivitySince &&
    now - Date.parse(state.connectivitySince) >= 15 * 60_000
  )
    add("extended_otg");
  if (state.safetyAlert || state.confidence === "safety_sensitive")
    add("safety_sensitive_escalation", null, "safety");
  if (state.authority === "escalate")
    add("authority_escalation", null, "safety");
  for (const [id, count] of Object.entries(state.agentFailures))
    if (count >= 3) add("repeated_agent_failures", id);
  for (const [id, health] of Object.entries(state.agentHealth))
    if (health !== "healthy") add("agent_health_degraded", id);
  for (const [id, task] of Object.entries({
    ...state.tasks,
    ...state.internalTasks,
  })) {
    if (task.recoveries >= 3) add("repeated_recovery_loop", id);
    if (
      [
        "queued",
        "running",
        "blocked",
        "progress",
        "dispatched",
        "recovered",
      ].includes(task.status) &&
      now - Date.parse(task.updatedAt) >= 10 * 60_000
    )
      add("stuck_task", id);
  }
  return alerts;
}

export interface CommandCentreSnapshot {
  state: OperationalState;
  history: OperationalEvent[];
  alerts: OperationalAlert[];
  durability: "durable" | "not_consented" | "unavailable";
  historyTruncated: boolean;
}

/** Filters only narrow an already-authorized stream. Never replay a filtered history. */
export function projectCommandCentre(
  state: OperationalState,
  history: OperationalEvent[],
  filters: OperationalFilters = {},
  now = Date.now(),
  durability: CommandCentreSnapshot["durability"] = "durable",
): CommandCentreSnapshot {
  const matches = history.filter((e) => {
    const agentId = "agentId" in e.payload ? e.payload.agentId : undefined;
    const taskStatus =
      "taskId" in e
        ? (state.internalTasks[e.taskId]?.status ??
          state.tasks[e.taskId]?.status)
        : undefined;
    return (
      (!filters.organizationId ||
        e.scope.organizationId === filters.organizationId) &&
      (!filters.siteId || e.scope.siteId === filters.siteId) &&
      (!filters.crewId || e.crewId === filters.crewId) &&
      (!filters.userId || e.scope.userId === filters.userId) &&
      (!filters.sessionId || e.sessionId === filters.sessionId) &&
      (!filters.agentId || agentId === filters.agentId) &&
      (!filters.eventType || e.type === filters.eventType) &&
      (!filters.severity || e.severity === filters.severity) &&
      (!filters.taskStatus || taskStatus === filters.taskStatus) &&
      (!filters.connectivity || state.connectivity === filters.connectivity)
    );
  });
  return {
    state,
    history: matches.slice(-200),
    alerts: operationalAlerts(state, now, durability !== "unavailable"),
    durability,
    historyTruncated: matches.length > 200,
  };
}
