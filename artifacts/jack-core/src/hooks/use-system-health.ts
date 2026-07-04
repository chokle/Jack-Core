import {
  useGetSystemHealth,
  getGetSystemHealthQueryKey,
  type SystemHealthSnapshot,
} from "@workspace/api-client-react";

/** How often to poll the live Systems Health snapshot. */
const POLL_MS = 2500;

/**
 * Number of consecutive failed polls before the widget is considered offline.
 * Two misses (~5s) rides out a single transient hiccup without pretending the
 * backend is healthy when it is actually unreachable.
 */
const OFFLINE_AFTER_FAILURES = 2;

/**
 * Steady, healthy default shown before the first poll resolves so the heartbeat
 * widget always renders a sensible resting state instead of flickering empty.
 * NOTE: this is only used while genuinely loading — once polling starts failing
 * the hook reports `isOffline` so the widget can show a distinct degraded state
 * rather than a misleading "Healthy".
 */
const RESTING: SystemHealthSnapshot = {
  vitalityScore: 100,
  heartbeatBPM: 68,
  pulseColor: "green",
  status: "Healthy",
  state: "idle",
};

export interface SystemHealthFeed {
  snapshot: SystemHealthSnapshot;
  isLoading: boolean;
  /** True once polling has failed repeatedly — the backend is unreachable. */
  isOffline: boolean;
}

/**
 * Live Systems Health feed for the heartbeat widget. A thin wrapper over the
 * generated `useGetSystemHealth` query that polls on a fixed cadence and keeps
 * the last good snapshot. React Query dedupes concurrent widget instances
 * (sidebar + mobile header) onto a single request via the shared query key.
 */
export function useSystemHealth(): SystemHealthFeed {
  const { data, isLoading, failureCount } = useGetSystemHealth({
    query: {
      queryKey: getGetSystemHealthQueryKey(),
      refetchInterval: POLL_MS,
    },
  });

  return {
    snapshot: (data as SystemHealthSnapshot | undefined) ?? RESTING,
    isLoading,
    isOffline: failureCount >= OFFLINE_AFTER_FAILURES,
  };
}
