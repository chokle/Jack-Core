import { trackTestEvent } from "./test-session-service";

export const ACTIVITY_HEARTBEAT_INTERVAL_MS = 60_000;
export const ACTIVITY_INACTIVITY_CUTOFF_MS = 5 * 60_000;

type Clock = Pick<typeof window, "setInterval" | "clearInterval"> & {
  now: () => number;
};

export function initializeActivityHeartbeat(
  clock: Clock = {
    setInterval: window.setInterval.bind(window),
    clearInterval: window.clearInterval.bind(window),
    now: Date.now,
  },
): () => void {
  let lastMeaningfulActivityAt: number | null = null;

  const emit = () => {
    const foreground = document.visibilityState === "visible";
    const meaningful =
      foreground &&
      lastMeaningfulActivityAt != null &&
      clock.now() - lastMeaningfulActivityAt <= ACTIVITY_INACTIVITY_CUTOFF_MS;
    void trackTestEvent("activity_heartbeat", {
      visibility: foreground ? "foreground" : "hidden",
      meaningful_activity: meaningful,
    });
  };
  const markMeaningfulActivity = () => {
    if (document.visibilityState === "visible")
      lastMeaningfulActivityAt = clock.now();
  };
  const onVisibilityChange = () => {
    if (document.visibilityState !== "visible") lastMeaningfulActivityAt = null;
    emit();
  };

  for (const eventName of ["pointerdown", "keydown", "touchstart"] as const) {
    window.addEventListener(eventName, markMeaningfulActivity, {
      passive: true,
    });
  }
  document.addEventListener("visibilitychange", onVisibilityChange);
  const interval = clock.setInterval(emit, ACTIVITY_HEARTBEAT_INTERVAL_MS);
  emit();

  return () => {
    clock.clearInterval(interval);
    for (const eventName of ["pointerdown", "keydown", "touchstart"] as const) {
      window.removeEventListener(eventName, markMeaningfulActivity);
    }
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
