import { randomUUID } from "node:crypto";
import type { Response } from "express";
import {
  createOperationalState,
  OperationalEventSchema,
  projectFieldState,
  reduceOperationalEvent,
  type OperationalEvent,
  type OperationalEventInput,
  type OperationalScope,
  type OperationalState,
} from "@workspace/api-zod";

/** Personal state only until a trusted site-membership adapter exists. Null is
 * an unassigned scope, never a wildcard. No client may choose a scope. */
export function personalOperationalScope(userId: string): OperationalScope {
  return { userId, organizationId: null, siteId: null };
}

export type EventInput = OperationalEventInput extends infer E
  ? E extends OperationalEventInput
    ? Omit<E, "version" | "id" | "sequence" | "scope">
    : never
  : never;

export function operationalProvenance(input: EventInput, now = Date.now()) {
  const safety =
    input.type === "safety.alert" || input.type === "authority.escalated";
  const urgent =
    /failed|blocked|interrupted|missed|denied|confirmation_required/.test(
      input.type,
    ) ||
    ("status" in input.payload &&
      ["failed", "blocked", "interrupted"].includes(input.payload.status));
  return {
    occurredAt: new Date(now).toISOString(),
    severity: safety
      ? ("safety" as const)
      : urgent
        ? ("urgent" as const)
        : ("normal" as const),
    source: input.type.startsWith("agent.")
      ? ("agent_runtime" as const)
      : input.type.startsWith("voice.")
        ? ("voice" as const)
        : ("jack" as const),
    ...input,
  };
}

/** Ephemeral operational display, not a durable worker queue or telemetry log.
 * One writer per process. Do not attach a distributed executor to this store. */
export class OperationalStateStore {
  private entries = new Map<
    string,
    {
      state: OperationalState;
      sequence: number;
      touched: number;
      history: OperationalEvent[];
    }
  >();
  constructor(
    private readonly now = Date.now,
    private readonly maxEntries = 1000,
  ) {}

  private entry(scope: OperationalScope) {
    const key = JSON.stringify([
      scope.userId,
      scope.organizationId,
      scope.siteId,
    ]);
    const now = this.now();
    for (const [storedKey, value] of this.entries) {
      if (now - value.touched > 30 * 60_000) this.entries.delete(storedKey);
    }
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= this.maxEntries)
        this.entries.delete(this.entries.keys().next().value!);
      entry = {
        state: createOperationalState(scope),
        sequence: 0,
        touched: now,
        history: [],
      };
    }
    entry.touched = now;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  read(scope: OperationalScope) {
    return structuredClone(this.entry(scope).state);
  }
  readField(scope: OperationalScope) {
    return projectFieldState(this.read(scope));
  }
  history(scope: OperationalScope) {
    return structuredClone(this.entry(scope).history);
  }

  /** Trusted in-process publishers only. HTTP accepts no arbitrary events. */
  publish(scope: OperationalScope, input: EventInput) {
    const entry = this.entry(scope);
    const event = OperationalEventSchema.parse({
      ...operationalProvenance(input, this.now()),
      scope,
      version: 1,
      id: randomUUID(),
      sequence: entry.sequence + 1,
    });
    entry.state = reduceOperationalEvent(entry.state, event);
    entry.history.push(event);
    if (entry.history.length > 200) entry.history.shift();
    entry.sequence += 1;
    return this.readField(scope);
  }
}

export const operationalState = new OperationalStateStore();

/** Observes the existing Jack request; does not make workflow/authority decisions. */
export function observeJackTask(
  userId: string,
  res: Response,
  publisher?: (input: EventInput) => Promise<void>,
) {
  const scope = personalOperationalScope(userId);
  const taskId = randomUUID();
  let pending = Promise.resolve();
  const publish = (_scope: OperationalScope, event: EventInput) => {
    if (!publisher) {
      operationalState.publish(scope, event);
      return;
    }
    pending = pending
      .then(() => publisher({ ...event, correlationId: taskId }))
      .catch(() => {
        // The bus reports ingestion health; display persistence cannot bypass or
        // break the existing Jack authority/consent decision path.
      });
  };
  let blocked = false;
  let ended = false;
  publish(scope, { type: "intent.resolved", audience: "field", payload: {} });
  publish(scope, {
    type: "task.dispatched",
    taskId,
    audience: "field",
    payload: {},
  });
  publish(scope, {
    type: "task.progress",
    taskId,
    audience: "field",
    payload: {},
  });
  const end = (interrupted: boolean) => {
    if (ended) return;
    ended = true;
    publish(scope, {
      type: interrupted
        ? "task.interrupted"
        : blocked
          ? "task.blocked"
          : res.statusCode >= 400
            ? "task.failed"
            : "task.completed",
      taskId,
      audience: "field",
      payload: {},
    });
  };
  res.once("finish", () => end(false));
  res.once("close", () => end(!res.writableFinished));
  return {
    authorityBlocked() {
      blocked = true;
      publish(scope, {
        type: "safety.alert",
        audience: "field",
        payload: {},
        severity: "safety",
        source: "authority",
      });
      publish(scope, {
        type: "authority.denied",
        audience: "field",
        payload: {},
        severity: "safety",
        source: "authority",
      });
    },
  };
}
