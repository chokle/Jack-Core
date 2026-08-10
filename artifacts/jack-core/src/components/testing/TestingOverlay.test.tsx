// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { fireEvent } from "@testing-library/react";
import { TestingOverlay, type TestingOverlayHandle } from "./TestingOverlay";

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

interface FakeStopResult {
  blob: Blob;
  mimeType: string;
  durationMs: number;
  screenResolution: string;
  micIncluded: boolean;
  stopReason: "user" | "native-stop-sharing" | "error";
}

const recordingFixture = vi.hoisted(() => {
  const state = {
    instance: null as unknown as RecordingServiceMock | null,
    ended: null as (() => void) | null,
  };

  class RecordingServiceMock {
    static callCount = 0;
    stopCalls = 0;
    pauseCalls = 0;
    resumeCalls = 0;
    startCalls = 0;
    elapsedCalls = 0;
    paused = false;
    started = false;
    stopped = false;
    lastStopReason: string | null = null;
    private stopResult: FakeStopResult | null = {
      blob: new Blob(["fake"], { type: "video/webm" }),
      mimeType: "video/webm",
      durationMs: 1200,
      screenResolution: "1280x720",
      micIncluded: false,
      stopReason: "user",
    };
    private onStop?: (result: FakeStopResult | null) => void;
    private onPauseStateChange?: (isPaused: boolean) => void;

    constructor(callbacks: {
      onStop?: (result: FakeStopResult | null) => void;
      onPauseStateChange?: (isPaused: boolean) => void;
    }) {
      this.onStop = callbacks.onStop;
      this.onPauseStateChange = callbacks.onPauseStateChange;
      state.instance = this;
      state.ended = () => this.triggerEnded();
      RecordingServiceMock.callCount += 1;
    }

    get isRecording() {
      return this.started && !this.stopped;
    }

    get isPaused() {
      return this.paused;
    }

    get micIncluded() {
      return false;
    }

    start() {
      this.startCalls += 1;
      this.started = true;
      this.stopped = false;
      this.paused = false;
      this.onPauseStateChange?.(false);
      return Promise.resolve();
    }

    pause() {
      this.pauseCalls += 1;
      if (!this.started || this.stopped || this.paused) return false;
      this.paused = true;
      this.onPauseStateChange?.(true);
      return true;
    }

    resume() {
      this.resumeCalls += 1;
      if (!this.started || this.stopped || !this.paused) return false;
      this.paused = false;
      this.onPauseStateChange?.(false);
      return true;
    }

    stop(reason: "user" | "native-stop-sharing" | "error" = "user") {
      this.lastStopReason = reason;
      this.stopCalls += 1;
      if (this.stopCalls > 1) {
        return Promise.resolve(
          this.stopResult && {
            ...this.stopResult,
            stopReason:
              (this.lastStopReason as
                | "user"
                | "native-stop-sharing"
                | "error") ?? "user",
          },
        );
      }
      this.stopped = true;
      const result = this.stopResult && {
        ...this.stopResult,
        stopReason:
          (reason as "user" | "native-stop-sharing" | "error") ?? "user",
      };
      this.onStop?.(result ?? null);
      return Promise.resolve(result);
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
  isScreenRecordingSupported: () => true,
}));
vi.mock("@/lib/user-testing/upload-service", () => ({
  uploadTestRecording: (..._args: unknown[]) => recordingUpload(..._args),
}));
vi.mock("@/lib/user-testing/test-session-service", () => ({
  getCachedTestSession: () => sharedSession,
  loadCurrentTestSession: vi.fn(async () => sharedSession),
  trackTestEvent: vi.fn(),
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
    isPaused,
    onPause,
    onResume,
    onStop,
  }: {
    isPaused: boolean;
    onPause: () => void;
    onResume: () => void;
    onStop: () => void;
  }) => (
    <div>
      <button type="button" onClick={isPaused ? onResume : onPause}>
        {isPaused ? "Resume" : "Pause"}
      </button>
      <button type="button" onClick={onStop}>
        Stop Test
      </button>
    </div>
  ),
}));
vi.mock("./ThinkAloudBanner", () => ({ ThinkAloudBanner: () => null }));

function renderOverlay() {
  const ref = createRef<TestingOverlayHandle>();
  render(<TestingOverlay ref={ref} />);
  act(() => ref.current?.open());
  return ref;
}

describe("TestingOverlay lifecycle", () => {
  beforeEach(() => {
    recordingFixture.RecordingServiceMock.callCount = 0;
    recorderServiceState.instance = null;
    recorderServiceState.ended = null;
    recordingUpload.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("works when stopping after pause and removes recording UI", async () => {
    renderOverlay();
    fireEvent.click(screen.getByTestId("testing-overlay-start"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(recorderServiceState.instance?.pauseCalls).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Stop Test" }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Stop Test" })).toBeNull();
    });
    expect(recorderServiceState.instance?.stopCalls).toBe(1);
  });

  it("treats browser share-end as a normal stop and remains safe to stop again", async () => {
    renderOverlay();
    fireEvent.click(screen.getByTestId("testing-overlay-start"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));

    act(() => {
      recorderServiceState.ended?.();
    });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Stop Test" })).toBeNull(),
    );
    const instance = recorderServiceState.instance;
    expect(instance?.stopCalls).toBe(1);
    expect(instance?.lastStopReason).toBe("native-stop-sharing");
  });
});
