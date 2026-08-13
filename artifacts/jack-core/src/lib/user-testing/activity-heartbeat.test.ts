// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const trackTestEvent = vi.hoisted(() => vi.fn(async () => null));
vi.mock("./test-session-service", () => ({ trackTestEvent }));

import {
  ACTIVITY_HEARTBEAT_INTERVAL_MS,
  ACTIVITY_INACTIVITY_CUTOFF_MS,
  initializeActivityHeartbeat,
} from "./activity-heartbeat";

describe("activity heartbeat", () => {
  let now = 0;
  let tick: (() => void) | null = null;
  let visibility: DocumentVisibilityState = "visible";

  beforeEach(() => {
    trackTestEvent.mockClear();
    now = 0;
    tick = null;
    visibility = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(
      () => visibility,
    );
  });

  function start() {
    return initializeActivityHeartbeat({
      now: () => now,
      setInterval: ((callback: () => void) => {
        tick = callback;
        return 1;
      }) as typeof window.setInterval,
      clearInterval: vi.fn() as typeof window.clearInterval,
    });
  }

  it("emits health-only heartbeats until meaningful foreground activity occurs", () => {
    const stop = start();
    expect(trackTestEvent).toHaveBeenLastCalledWith("activity_heartbeat", {
      visibility: "foreground",
      meaningful_activity: false,
    });
    window.dispatchEvent(new Event("pointerdown"));
    now = ACTIVITY_HEARTBEAT_INTERVAL_MS;
    tick?.();
    expect(trackTestEvent).toHaveBeenLastCalledWith("activity_heartbeat", {
      visibility: "foreground",
      meaningful_activity: true,
    });
    stop();
  });

  it("never marks hidden heartbeats meaningful and expires inactivity after five minutes", () => {
    const stop = start();
    window.dispatchEvent(new Event("keydown"));
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(trackTestEvent).toHaveBeenLastCalledWith("activity_heartbeat", {
      visibility: "hidden",
      meaningful_activity: false,
    });
    visibility = "visible";
    now = ACTIVITY_INACTIVITY_CUTOFF_MS + 1;
    tick?.();
    expect(trackTestEvent).toHaveBeenLastCalledWith("activity_heartbeat", {
      visibility: "foreground",
      meaningful_activity: false,
    });
    stop();
  });
});
