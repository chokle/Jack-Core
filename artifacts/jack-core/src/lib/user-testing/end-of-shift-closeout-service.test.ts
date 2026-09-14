// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { setAuthTokenGetter } from "@workspace/api-client-react";
import { loadCloseout, saveCloseout } from "./end-of-shift-closeout-service";
import {
  loadTelemetryContext,
  startTestSession,
  invalidateTestSessionStarts,
} from "./test-session-service";

afterEach(() => {
  setAuthTokenGetter(null);
  invalidateTestSessionStarts();
  vi.unstubAllGlobals();
});

describe("pilot request authentication", () => {
  it("gets a fresh bearer for EOD read/write and telemetry setup", async () => {
    const tokens = [
      "read-token",
      "write-token",
      "context-token",
      "start-token",
    ];
    setAuthTokenGetter(() => tokens.shift() ?? null);
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await loadCloseout({ shift: "day" });
    await saveCloseout({
      workDate: "2026-09-13",
      shift: "day",
      status: "draft",
      answers: {},
    });
    await loadTelemetryContext();
    await startTestSession();
    expect(
      fetchMock.mock.calls.map(([, options]) =>
        new Headers(options.headers).get("authorization"),
      ),
    ).toEqual([
      "Bearer read-token",
      "Bearer write-token",
      "Bearer context-token",
      "Bearer start-token",
    ]);
    expect(
      fetchMock.mock.calls.every(
        ([, options]) => options.credentials === "include",
      ),
    ).toBe(true);
  });

  it("does not submit a closeout when token refresh fails", async () => {
    setAuthTokenGetter(() => Promise.reject(new Error("Session expired")));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      saveCloseout({
        workDate: "2026-09-13",
        shift: "day",
        status: "submitted",
        answers: {},
      }),
    ).rejects.toThrow("Session expired");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
