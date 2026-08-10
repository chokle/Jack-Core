// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { createRef, useEffect, useState } from "react";
import { fireEvent } from "@testing-library/react";
import { TestingOverlay, type TestingOverlayHandle } from "./TestingOverlay";

const recordingSupport = { value: true };
const recordingUpload = vi
  .fn()
  .mockResolvedValue({ status: "uploaded", id: "recording-1" });

const sharedSession = {
  id: "11111111-1111-4111-8111-111111111111",
  organizationId: "org",
  pilotId: "pilot",
  appSessionId: "app",
  status: "active" as const,
  telemetryStatus: "granted" as const,
  screenConsentState: "granted" as const,
  microphoneConsentState: "declined" as const,
  onboardingStatus: "not_started" as const,
  onboardingStep: 0,
  recordingStatus: "not_requested" as const,
  feedbackStatus: "not_requested" as const,
  questionCount: 0,
  startedAt: "2026-07-31T00:00:00Z",
  lastActivityAt: "2026-07-31T00:00:00Z",
  expiresAt: "2026-07-31T12:00:00Z",
};
const trackTestEvent = vi.fn(
  async (
    eventType: string,
    ..._rest: Array<string | number | boolean | Record<string, unknown>>
  ) => sharedSession,
);

interface FakeStopResult {
  blob: Blob;
  mimeType: string;
  durationMs: number;
  screenResolution: string;
  micIncluded: boolean;
  stopReason: "user" | "native-stop-sharing" | "error";
}

const defaultStopResult: FakeStopResult = {
  blob: new Blob(["fake"], { type: "video/webm" }),
  mimeType: "video/webm",
  durationMs: 1200,
  screenResolution: "1280x720",
  micIncluded: false,
  stopReason: "user",
};

const recordingFixture = vi.hoisted(() => {
  const state = {
    instance: null as unknown as RecordingServiceMock | null,
    ended: null as (() => void) | null,
    stopResult: null as FakeStopResult | null,
  };

  class RecordingServiceMock {
    static callCount = 0;
    stopCalls = 0;
    pauseCalls = 0;
    resumeCalls = 0;
    startCalls = 0;
    elapsedCalls = 0;
    stopReasons: string[] = [];
    lastStopReason: string | null = null;
    private stopped = false;
    private stopPromise: Promise<FakeStopResult | null> | null = null;
    private stopResult: FakeStopResult | null;
    private onStop?: (result: FakeStopResult | null) => void;
    private onPauseStateChange?: (isPaused: boolean) => void;

    constructor(callbacks: {
      onStop?: (result: FakeStopResult | null) => void;
      onPauseStateChange?: (isPaused: boolean) => void;
      onError?: () => void;
    }) {
      this.onStop = callbacks.onStop;
      this.onPauseStateChange = callbacks.onPauseStateChange;
      this.stopResult = state.stopResult;
      state.instance = this;
      state.ended = () => this.triggerEnded();
      RecordingServiceMock.callCount += 1;
    }

    get isRecording() {
      return this.startCalls > this.stopCalls;
    }

    get isPaused() {
      return this.pauseCalls > this.resumeCalls;
    }

    get micIncluded() {
      return false;
    }

    start() {
      this.startCalls += 1;
      this.onPauseStateChange?.(false);
      return Promise.resolve();
    }

    pause() {
      this.pauseCalls += 1;
      this.onPauseStateChange?.(true);
      return true;
    }

    resume() {
      this.resumeCalls += 1;
      this.onPauseStateChange?.(false);
      return true;
    }

    stop(reason: "user" | "native-stop-sharing" | "error" = "user") {
      if (this.stopped) return this.stopPromise ?? Promise.resolve(null);
      this.stopped = true;
      this.lastStopReason = reason;
      this.stopCalls += 1;
      this.stopReasons.push(reason);
      const result = this.stopResult;
      const effective = result && {
        ...result,
        stopReason: result.stopReason ?? reason,
      };
      const next = Promise.resolve(effective).then((payload) => {
        this.onStop?.(payload ?? null);
        return payload ?? null;
      });
      this.stopPromise = next;
      return next;
    }

    elapsedMs() {
      this.elapsedCalls += 1;
      return 1_000;
    }

    triggerEnded() {
      this.stop("native-stop-sharing");
    }
  }

  return { state, RecordingServiceMock };
});

const recorderServiceState = recordingFixture.state;

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));
vi.mock("@/lib/user-testing/recording-service", () => ({
  RecordingService: recordingFixture.RecordingServiceMock,
  isScreenRecordingSupported: () => recordingSupport.value,
}));
vi.mock("@/lib/user-testing/upload-service", () => ({
  uploadTestRecording: (..._args: unknown[]) => recordingUpload(..._args),
}));
vi.mock("@/lib/user-testing/test-session-service", () => ({
  getCachedTestSession: () => sharedSession,
  loadCurrentTestSession: vi.fn(async () => sharedSession),
  trackTestEvent: (...args: Parameters<typeof trackTestEvent>) =>
    trackTestEvent(...args),
}));
vi.mock("./UserTestingModal", () => ({
  UserTestingModal: ({
    open,
    onStart,
    onCancel,
  }: {
    open: boolean;
    onStart: () => void;
    onCancel: () => void;
  }) =>
    open ? (
      <div>
        <button
          type="button"
          data-testid="testing-overlay-start"
          onClick={onStart}
        />
        <button
          type="button"
          data-testid="testing-overlay-cancel"
          onClick={onCancel}
        />
      </div>
    ) : null,
}));
vi.mock("./RecordingIndicator", () => ({
  RecordingIndicator: ({
    getElapsedMs,
    isPaused,
    onPause,
    onResume,
    onStop,
  }: {
    getElapsedMs: () => number;
    isPaused: boolean;
    onPause: () => void;
    onResume: () => void;
    onStop: () => void;
  }) => {
    const [elapsed, setElapsed] = useState(0);

    useEffect(() => {
      const interval = window.setInterval(() => {
        setElapsed(getElapsedMs());
      }, 200);
      setElapsed(getElapsedMs());
      return () => window.clearInterval(interval);
    }, [getElapsedMs]);

    return (
      <div>
        <div data-testid="session-timer">{Math.round(elapsed)}</div>
        <button type="button" onClick={isPaused ? onResume : onPause}>
          {isPaused ? "Resume" : "Pause"}
        </button>
        <button type="button" onClick={onStop}>
          Stop Test
        </button>
      </div>
    );
  },
}));
vi.mock("./ThinkAloudBanner", () => ({ ThinkAloudBanner: () => null }));

function renderOverlay() {
  const ref = createRef<TestingOverlayHandle>();
  render(<TestingOverlay ref={ref} />);
  act(() => ref.current?.open());
  return ref;
}

function completedEvents() {
  return trackTestEvent.mock.calls.filter(
    (call) => call[0] === "test_completed",
  ).length;
}

function getPauseButton() {
  return screen.getByRole("button", { name: "Pause" });
}

function getResumeButton() {
  return screen.getByRole("button", { name: "Resume" });
}

function getStopButton() {
  return screen.getByRole("button", { name: "Stop Test" });
}

function timerValue() {
  return Number(screen.getByTestId("session-timer").textContent ?? "0");
}

describe("TestingOverlay lifecycle", () => {
  beforeEach(() => {
    recordingFixture.RecordingServiceMock.callCount = 0;
    recorderServiceState.instance = null;
    recorderServiceState.ended = null;
    recorderServiceState.stopResult = defaultStopResult;
    recordingUpload.mockClear();
    trackTestEvent.mockClear();
  });

  afterEach(() => {
    cleanup();
    recordingSupport.value = true;
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("allows pause/resume and stop after native sharing ended", async () => {
    renderOverlay();
    fireEvent.click(screen.getByTestId("testing-overlay-start"));
    await waitFor(() => expect(getPauseButton()).toBeTruthy());

    act(() => {
      recorderServiceState.ended?.();
    });

    await waitFor(() => {
      expect(recorderServiceState.instance?.lastStopReason).toBe(
        "native-stop-sharing",
      );
    });

    fireEvent.click(getPauseButton());
    await waitFor(() => expect(getResumeButton()).toBeTruthy());
    fireEvent.click(getResumeButton());
    fireEvent.click(getStopButton());

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Stop Test" })).toBeNull(),
    );
    expect(completedEvents()).toBe(1);
    expect(recorderServiceState.instance?.stopCalls).toBe(1);
  });

  it("freezes timer while paused and resumes correctly", async () => {
    renderOverlay();
    fireEvent.click(screen.getByTestId("testing-overlay-start"));
    await waitFor(() => expect(getPauseButton()).toBeTruthy());
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    expect(timerValue()).toBeGreaterThan(0);
    const beforePause = timerValue();
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    expect(timerValue()).toBeGreaterThan(beforePause);

    fireEvent.click(getPauseButton());
    await Promise.resolve();
    expect(getResumeButton()).toBeTruthy();
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    const duringPause = timerValue();
    expect(duringPause).toBeLessThanOrEqual(beforePause + 350);

    fireEvent.click(getResumeButton());
    await Promise.resolve();
    expect(getPauseButton()).toBeTruthy();
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    const afterResume = timerValue();
    expect(afterResume).toBeGreaterThan(duringPause);

    fireEvent.click(getStopButton());
    const secondStop = screen.queryByRole("button", { name: "Stop Test" });
    if (secondStop) {
      fireEvent.click(secondStop);
    }
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Stop Test" })).toBeNull(),
    );
    expect(completedEvents()).toBe(1);
  });

  it("completes even if stop is triggered by native end and upload fails", async () => {
    recordingUpload.mockResolvedValueOnce({
      status: "saved-locally",
      filename: "fallback.webm",
      reason: "forced failure",
    });

    renderOverlay();
    fireEvent.click(screen.getByTestId("testing-overlay-start"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy(),
    );

    act(() => {
      recorderServiceState.ended?.();
    });
    await waitFor(() =>
      expect(recorderServiceState.instance?.lastStopReason).toBe(
        "native-stop-sharing",
      ),
    );

    fireEvent.click(getStopButton());
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Stop Test" })).toBeNull(),
    );
    expect(completedEvents()).toBe(1);
    expect(recordingUpload).toHaveBeenCalledTimes(1);
    expect(
      trackTestEvent.mock.calls.some(
        (call) => call[0] === "recording_upload_failed",
      ),
    ).toBe(true);
  });

  it("completes when native stop yields null blob", async () => {
    recorderServiceState.stopResult = null;
    renderOverlay();
    fireEvent.click(screen.getByTestId("testing-overlay-start"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy(),
    );

    act(() => {
      recorderServiceState.ended?.();
    });

    await waitFor(() =>
      expect(recorderServiceState.instance?.stopCalls).toBe(1),
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop Test" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Stop Test" })).toBeNull(),
    );
    expect(completedEvents()).toBe(1);
    expect(recorderServiceState.instance?.stopCalls).toBe(1);
  });

  it("remains idempotent for repeated native ended and repeated stop actions", async () => {
    renderOverlay();
    fireEvent.click(screen.getByTestId("testing-overlay-start"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy(),
    );

    act(() => {
      recorderServiceState.ended?.();
      recorderServiceState.ended?.();
    });
    await waitFor(() =>
      expect(recorderServiceState.instance?.stopCalls).toBe(1),
    );

    fireEvent.click(getStopButton());
    const secondStopAfterNative = screen.queryByRole("button", {
      name: "Stop Test",
    });
    if (secondStopAfterNative) {
      fireEvent.click(secondStopAfterNative);
    }
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Stop Test" })).toBeNull(),
    );
    expect(completedEvents()).toBe(1);
  });

  it("starts no recording safely when screen capture support is unavailable", async () => {
    recordingSupport.value = false;
    renderOverlay();
    fireEvent.click(screen.getByTestId("testing-overlay-start"));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Pause" })).toBeNull(),
    );
    expect(recorderServiceState.instance).toBeNull();
    recordingSupport.value = true;
  });
});
