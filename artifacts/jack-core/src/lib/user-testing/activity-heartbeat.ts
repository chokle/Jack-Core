import { deviceCategory, getCachedTestSession } from "./test-session-service";

export const ACTIVITY_HEARTBEAT_INTERVAL_MS = 60_000;
export const ACTIVITY_INACTIVITY_CUTOFF_MS = 5 * 60_000;

export function initializeActivityHeartbeat(): () => void {
  let lastMeaningfulActivityAt: number | null = null;

  const markMeaningfulActivity = () => {
    if (document.visibilityState === "visible") {
      lastMeaningfulActivityAt = Date.now();
    }
  };

  const emit = async () => {
    const session = getCachedTestSession();
    if (!session) return;

    const foreground = document.visibilityState === "visible";
    const meaningfulActivity =
      foreground &&
      lastMeaningfulActivityAt != null &&
      Date.now() - lastMeaningfulActivityAt <= ACTIVITY_INACTIVITY_CUTOFF_MS;

    await fetch("/api/testing/activity-heartbeat", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appSessionId: session.appSessionId,
        visibility: foreground ? "foreground" : "hidden",
        meaningfulActivity,
        deviceCategory: deviceCategory(),
      }),
    }).catch(() => undefined);
  };

  const onVisibilityChange = () => {
    if (document.visibilityState !== "visible") {
      lastMeaningfulActivityAt = null;
    }
    void emit();
  };

  for (const eventName of ["pointerdown", "keydown", "touchstart"] as const) {
    window.addEventListener(eventName, markMeaningfulActivity, {
      passive: true,
    });
  }
  document.addEventListener("visibilitychange", onVisibilityChange);

  const interval = window.setInterval(
    () => void emit(),
    ACTIVITY_HEARTBEAT_INTERVAL_MS,
  );
  void emit();

  return () => {
    window.clearInterval(interval);
    for (const eventName of ["pointerdown", "keydown", "touchstart"] as const) {
      window.removeEventListener(eventName, markMeaningfulActivity);
    }
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
