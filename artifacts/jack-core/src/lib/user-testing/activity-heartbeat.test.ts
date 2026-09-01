// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cached = vi.hoisted(() => ({
  current: {
    id: "33333333-3333-4333-8333-333333333333",
    appSessionId: "44444444-4444-4444-8444-444444444444",
  },
}));
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("./test-session-service", () => ({
  deviceCategory: () => "mobile",
  getCachedTestSession: () => cached.current,
}));

import { initializeActivityHeartbeat } from "./activity-heartbeat";

describe("activity heartbeat sender", () => {
  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("binds every heartbeat to the exact cached test session", async () => {
    const stop = initializeActivityHeartbeat();
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
      expect(JSON.parse(String(requestInit.body))).toEqual({
        testSessionId: cached.current.id,
        appSessionId: cached.current.appSessionId,
        visibility: "foreground",
        meaningfulActivity: false,
        deviceCategory: "mobile",
      });
    } finally {
      stop();
    }
  });
});
