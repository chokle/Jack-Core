import { useMemo, useSyncExternalStore } from "react";
import { customFetch } from "@workspace/api-client-react";
import {
  FieldOperationalStateSchema,
  type FieldOperationalState,
} from "@workspace/api-zod";

export type OperationalSnapshot = {
  state: FieldOperationalState | null;
  unavailable: boolean;
};
const empty: OperationalSnapshot = { state: null, unavailable: false };

/** One read-only subscription per authenticated identity. Core alone reduces events. */
export function createOperationalSubscription(userId: string) {
  let snapshot = empty;
  const listeners = new Set<() => void>();
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function publish(next: OperationalSnapshot) {
    snapshot = next;
    listeners.forEach((listener) => listener());
  }
  async function refresh() {
    if (!listeners.size || controller) return;
    const request = new AbortController();
    controller = request;
    try {
      const response = await customFetch<unknown>("/api/operational/state", {
        signal: request.signal,
      });
      const state = FieldOperationalStateSchema.parse(response);
      if (state.scope.userId !== userId) throw new Error("Identity changed");
      if (!request.signal.aborted) publish({ state, unavailable: false });
    } catch {
      if (!request.signal.aborted) publish({ state: null, unavailable: true });
    } finally {
      if (controller === request) controller = null;
      if (!request.signal.aborted && listeners.size)
        timer = setTimeout(() => void refresh(), 3000);
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) void refresh();
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          clearTimeout(timer);
          controller?.abort();
          controller = null;
          snapshot = empty;
        }
      };
    },
  };
}
const subscriptions = new Map<
  string,
  ReturnType<typeof createOperationalSubscription>
>();
export function useOperationalState(userId: string) {
  const store = useMemo(() => {
    let existing = subscriptions.get(userId);
    if (!existing) {
      existing = createOperationalSubscription(userId);
      subscriptions.set(userId, existing);
    }
    return existing;
  }, [userId]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, () => empty);
}
