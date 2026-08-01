// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cacheTestSession,
  flushTestEvents,
  getCachedTestSession,
  loadCurrentTestSession,
  startTestSession,
  trackTestEvent,
  withdrawTelemetry,
  type TestSession,
} from "./test-session-service";

type TestQueuedEvent = {
  sessionId: string;
  eventId: string;
  eventType:
    | "test_completed"
    | "test_abandoned"
    | "onboarding_started"
    | "onboarding_step_completed"
    | "onboarding_completed"
    | "onboarding_skipped"
    | "feature_viewed"
    | "workflow_completed"
    | "recording_started"
    | "recording_stopped"
    | "recording_upload_succeeded"
    | "recording_upload_failed"
    | "feedback_submitted"
    | "reliability_error";
  occurredAt: string;
  appSessionId: string;
  metadata: Record<string, string | number | boolean>;
  result: "success" | "failure" | "cancelled" | "unavailable";
  correlationId?: string;
  requestId?: string;
  dedupeKey?: string;
  appVersion?: string;
  deployVersion?: string;
  deviceCategory: "desktop" | "tablet" | "mobile";
  schemaVersion: 1;
};

const session: TestSession = {
  id: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
  pilotId: "33333333-3333-4333-8333-333333333333",
  appSessionId: "44444444-4444-4444-8444-444444444444",
  status: "active",
  telemetryStatus: "granted",
  screenConsentState: "declined",
  microphoneConsentState: "declined",
  onboardingStatus: "in_progress",
  onboardingStep: 1,
  recordingStatus: "not_requested",
  feedbackStatus: "not_requested",
  questionCount: 0,
  startedAt: "2026-07-24T12:00:00.000Z",
  resumedAt: null,
  lastActivityAt: "2026-07-24T12:00:00.000Z",
  expiresAt: "2026-07-31T12:00:00.000Z",
};

describe("test session service", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  const queuedEvent = (eventId: string, overrides: Partial<TestQueuedEvent> = {}): TestQueuedEvent => ({
    sessionId: session.id,
    eventId,
    eventType: "feature_viewed",
    occurredAt: "2026-07-31T12:00:00.000Z",
    appSessionId: session.appSessionId,
    metadata: {},
    result: "success",
    appVersion: "1",
    deployVersion: "1",
    deviceCategory: "desktop",
    schemaVersion: 1,
    ...overrides,
  });

  it("deduplicates concurrent starts and caches the canonical server session", async () => {
    let resolveResponse!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const fetchMock = vi.fn(() => pending);
    vi.stubGlobal("fetch", fetchMock);

    const first = startTestSession();
    const second = startTestSession();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveResponse(new Response(JSON.stringify({ session, resumed: false }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }));

    expect(await first).toEqual(session);
    expect(await second).toEqual(session);
    expect(getCachedTestSession()).toEqual(session);
  });

  it("restores the current session and sends only event metadata", async () => {
    const updated = { ...session, onboardingStep: 2 };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ session }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ session: updated }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await loadCurrentTestSession()).toEqual(session);
    expect(
      await trackTestEvent(
        "onboarding_step_completed",
        { step: 1, next_step: 2 },
        "onboarding_step:1",
      ),
    ).toEqual(updated);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({
      eventType: "onboarding_step_completed",
      metadata: { step: 1, next_step: 2 },
      dedupeKey: "onboarding_step:1",
      schemaVersion: 1,
      appSessionId: expect.any(String),
      eventId: expect.any(String),
      deviceCategory: expect.stringMatching(/desktop|tablet|mobile/),
    });
  });

  it("keeps retryable events durably queued and reuses the same event id", async () => {
    cacheTestSession(session);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ session }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await trackTestEvent("feature_viewed", { feature: "library" }, "feature:library");
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(JSON.parse(localStorage.getItem("jack.userTesting.eventQueue.v1") ?? "[]")).toHaveLength(1);

    await flushTestEvents();
    const retryBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(retryBody.eventId).toBe(firstBody.eventId);
    expect(JSON.parse(localStorage.getItem("jack.userTesting.eventQueue.v1") ?? "[]")).toEqual([]);
  });

  it("removes successfully submitted events from an in-memory queue snapshot if storage writes fail", async () => {
    cacheTestSession(session);
    const events = [queuedEvent("e-1"), queuedEvent("e-2")];
    localStorage.setItem("jack.userTesting.eventQueue.v1", JSON.stringify(events));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ session }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response("{}", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });

    await flushTestEvents();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).eventId).toBe("e-1");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).eventId).toBe("e-2");
  });

  it.each([408, 429, 503] as const)(
    "retains retryable status %s responses in queue without dropping subsequent events",
    async (status) => {
      cacheTestSession(session);
      localStorage.setItem(
        "jack.userTesting.eventQueue.v1",
        JSON.stringify([queuedEvent("queued-retry")]),
      );
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ session }), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      await flushTestEvents();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).eventId).toBe("queued-retry");
      expect(JSON.parse(localStorage.getItem("jack.userTesting.eventQueue.v1") ?? "[]")).toEqual(
        [queuedEvent("queued-retry")],
      );
    },
  );

  it("drops non-retryable client errors after one submission attempt", async () => {
    cacheTestSession(session);
    localStorage.setItem(
      "jack.userTesting.eventQueue.v1",
      JSON.stringify([queuedEvent("queued-4xx")]),
    );
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("{}", {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await flushTestEvents();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem("jack.userTesting.eventQueue.v1") ?? "[]")).toEqual([]);
  });

  it("drops unauthorized events that cannot be safely retried across identity changes", async () => {
    cacheTestSession(session);
    localStorage.setItem(
      "jack.userTesting.eventQueue.v1",
      JSON.stringify([queuedEvent("queued-401", { appSessionId: "stale-session-id" })]),
    );
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("{}", {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await flushTestEvents();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem("jack.userTesting.eventQueue.v1") ?? "[]")).toEqual([]);
  });

  it("flushes multiple events in deterministic order and only removes each once", async () => {
    cacheTestSession(session);
    const events = [queuedEvent("queued-1"), queuedEvent("queued-2"), queuedEvent("queued-3")];
    localStorage.setItem("jack.userTesting.eventQueue.v1", JSON.stringify(events));
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ session }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await flushTestEvents();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).eventId)).toEqual(
      ["queued-1", "queued-2", "queued-3"],
    );
    expect(JSON.parse(localStorage.getItem("jack.userTesting.eventQueue.v1") ?? "[]")).toEqual([]);
  });

  it("clears the local session and pending queue immediately on withdrawal", async () => {
    cacheTestSession(session);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        withdrawn: ["telemetry", "screen", "microphone"],
        deletionDueAt: "2026-08-24T00:00:00.000Z",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await trackTestEvent("feature_viewed", { feature: "library" });
    await withdrawTelemetry(session.pilotId);

    expect(getCachedTestSession()).toBeNull();
    expect(JSON.parse(localStorage.getItem("jack.userTesting.eventQueue.v1") ?? "[]")).toEqual([]);
  });

  it("stops local telemetry immediately even when the withdrawal request fails", async () => {
    cacheTestSession(session);
    localStorage.setItem(
      "jack.userTesting.eventQueue.v1",
      JSON.stringify([{ id: "queued-event" }]),
    );
    const stopped = vi.fn();
    window.addEventListener("jack:telemetry-withdrawn", stopped);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("{}", { status: 503 }),
    ));

    await expect(withdrawTelemetry(session.pilotId)).rejects.toThrow();

    expect(getCachedTestSession()).toBeNull();
    expect(JSON.parse(localStorage.getItem("jack.userTesting.eventQueue.v1") ?? "[]")).toEqual([]);
    expect(stopped).toHaveBeenCalledTimes(1);
  });
});
