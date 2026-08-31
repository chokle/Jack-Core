// @vitest-environment jsdom
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { TestingOverlay, type TestingOverlayHandle } from "./TestingOverlay";

const state = vi.hoisted(() => ({
  cachedSession: null as null | Record<string, unknown>,
  currentSession: null as null | Record<string, unknown>,
  recordingStart: null as null | (() => Promise<void>),
  recordingOnStop: null as null | ((result: {
    blob: Blob;
    durationMs: number;
    mimeType: string;
    micIncluded: boolean;
    stopReason: "user";
  }) => void),
}));

const recordingServiceCtorSpy = vi.fn();
const recordingServiceStartSpy = vi.fn();
const recordingServiceCancelSpy = vi.fn();
const uploadTestRecordingSpy = vi.fn();
const loadCurrentTestSessionSpy = vi.fn(
  async (_pilotId?: string, _options?: unknown) => state.currentSession,
);

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/user-testing/test-session-service", () => ({
  getCachedTestSession: () => state.cachedSession,
  loadCurrentTestSession: (
    pilotId?: string,
    options?: {
      signal?: AbortSignal;
      shouldCache?: () => boolean;
    },
  ) => loadCurrentTestSessionSpy(pilotId, options),
  trackTestEvent: vi.fn(),
}));
vi.mock("@/lib/user-testing/recording-service", () => ({
  RecordingService: class {
    constructor(options: {
      onStop: NonNullable<typeof state.recordingOnStop>;
    }) {
      state.recordingOnStop = options.onStop;
      recordingServiceCtorSpy();
    }
    async start() {
      recordingServiceStartSpy();
      await state.recordingStart?.();
    }
    stop() {
      return Promise.resolve();
    }
    cancel() {
      recordingServiceCancelSpy();
    }
    pause() {}
    resume() {}
  },
  isScreenRecordingSupported: () => true,
}));
vi.mock("@/lib/user-testing/upload-service", () => ({
  uploadTestRecording: (...args: unknown[]) => uploadTestRecordingSpy(...args),
}));
vi.mock("./UserTestingModal", () => ({
  UserTestingModal: ({ open, onStart, onCancel }: {
    open: boolean;
    onStart: () => void;
    onCancel: () => void;
  }) =>
    open ? (
      <div>
        <button type="button" data-testid="testing-overlay-start" onClick={onStart} />
        <button type="button" data-testid="testing-overlay-cancel" onClick={onCancel} />
      </div>
    ) : null,
}));
vi.mock("./RecordingIndicator", () => ({ RecordingIndicator: () => null }));
vi.mock("./ThinkAloudBanner", () => ({ ThinkAloudBanner: () => null }));

describe("TestingOverlay consent boundary", () => {
  beforeEach(() => {
    state.cachedSession = null;
    state.currentSession = null;
    state.recordingStart = null;
    state.recordingOnStop = null;
    recordingServiceCtorSpy.mockClear();
    recordingServiceStartSpy.mockClear();
    recordingServiceCancelSpy.mockClear();
    uploadTestRecordingSpy.mockReset();
    loadCurrentTestSessionSpy.mockReset();
    loadCurrentTestSessionSpy.mockImplementation(
      async () => state.currentSession,
    );
    window.history.replaceState({}, "", "/app");
    sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it("opens even without a cached session", () => {
    const ref = createRef<TestingOverlayHandle>();
    render(<TestingOverlay ref={ref} identityKey="test-user" />);

    act(() => ref.current?.open());

    expect(screen.getByTestId("testing-overlay-start")).toBeTruthy();
    expect(screen.getByTestId("testing-overlay-cancel")).toBeTruthy();
  });

  it("does not construct recording service without any active session", async () => {
    const ref = createRef<TestingOverlayHandle>();
    render(<TestingOverlay ref={ref} identityKey="test-user" />);

    act(() => ref.current?.open());
    const start = screen.getByTestId("testing-overlay-start");
    fireEvent.click(start);

    expect(recordingServiceCtorSpy).not.toHaveBeenCalled();
    expect(recordingServiceStartSpy).not.toHaveBeenCalled();
  });

  it("cancels recording work when the active identity changes", async () => {
    state.cachedSession = {
      id: "11111111-1111-4111-8111-111111111111",
      organizationId: "org",
      pilotId: "pilot",
      appSessionId: "app",
      status: "active",
      telemetryStatus: "granted",
      screenConsentState: "granted",
      microphoneConsentState: "granted",
      onboardingStatus: "not_started",
      onboardingStep: 0,
      recordingStatus: "not_started",
      feedbackStatus: "not_started",
      questionCount: 0,
      startedAt: "2026-07-31T00:00:00Z",
      lastActivityAt: "2026-07-31T00:00:00Z",
      expiresAt: "2026-07-31T12:00:00Z",
    };

    const ref = createRef<TestingOverlayHandle>();
    const rendered = render(
      <TestingOverlay ref={ref} identityKey="user-a" />,
    );
    act(() => ref.current?.open());
    fireEvent.click(screen.getByTestId("testing-overlay-start"));
    expect(recordingServiceStartSpy).toHaveBeenCalledTimes(1);

    rendered.rerender(
      <TestingOverlay ref={ref} identityKey="user-b" />,
    );

    expect(recordingServiceCancelSpy).toHaveBeenCalledTimes(1);
  });

  it("requires an active session to construct recording service", async () => {
    state.cachedSession = {
      id: "11111111-1111-4111-8111-111111111111",
      organizationId: "org",
      pilotId: "pilot",
      appSessionId: "app",
      status: "active",
      telemetryStatus: "granted",
      screenConsentState: "granted",
      microphoneConsentState: "granted",
      onboardingStatus: "not_started",
      onboardingStep: 0,
      recordingStatus: "not_started",
      feedbackStatus: "not_started",
      questionCount: 0,
      startedAt: "2026-07-31T00:00:00Z",
      lastActivityAt: "2026-07-31T00:00:00Z",
      expiresAt: "2026-07-31T12:00:00Z",
    };

    const ref = createRef<TestingOverlayHandle>();
    render(<TestingOverlay ref={ref} identityKey="test-user" />);

    act(() => ref.current?.open());
    fireEvent.click(screen.getByTestId("testing-overlay-start"));

    expect(recordingServiceCtorSpy).toHaveBeenCalledTimes(1);
    expect(recordingServiceStartSpy).toHaveBeenCalledTimes(1);
  });
  it("aborts an in-flight upload when the active identity changes", async () => {
    state.cachedSession = {
      id: "11111111-1111-4111-8111-111111111111",
      organizationId: "org",
      pilotId: "pilot",
      appSessionId: "app",
      status: "active",
      telemetryStatus: "granted",
      screenConsentState: "granted",
      microphoneConsentState: "granted",
      onboardingStatus: "not_started",
      onboardingStep: 0,
      recordingStatus: "not_started",
      feedbackStatus: "not_started",
      questionCount: 0,
      startedAt: "2026-07-31T00:00:00Z",
      lastActivityAt: "2026-07-31T00:00:00Z",
      expiresAt: "2026-07-31T12:00:00Z",
    };
    let resolveUpload:
      | ((outcome: { status: "uploaded"; id: string }) => void)
      | undefined;
    uploadTestRecordingSpy.mockImplementation(
      () =>
        new Promise<{ status: "uploaded"; id: string }>((resolve) => {
          resolveUpload = resolve;
        }),
    );
    const onEvent = vi.fn();
    const ref = createRef<TestingOverlayHandle>();
    const rendered = render(
      <TestingOverlay
        key="user-a"
        ref={ref}
        identityKey="user-a"
        onEvent={onEvent}
      />,
    );

    act(() => ref.current?.open());
    fireEvent.click(screen.getByTestId("testing-overlay-start"));
    await waitFor(() => expect(onEvent).toHaveBeenCalledWith("started"));

    act(() => {
      state.recordingOnStop?.({
        blob: new Blob(["recording"], { type: "video/webm" }),
        durationMs: 2_000,
        mimeType: "video/webm",
        micIncluded: true,
        stopReason: "user",
      });
    });
    await waitFor(() =>
      expect(uploadTestRecordingSpy).toHaveBeenCalledTimes(1),
    );

    const uploadMetadata = uploadTestRecordingSpy.mock.calls[0]?.[1] as {
      identityKey?: string;
    };
    const uploadOptions = uploadTestRecordingSpy.mock.calls[0]?.[2] as {
      signal: AbortSignal;
      shouldFallback: () => boolean;
    };
    expect(uploadMetadata.identityKey).toBe("user-a");
    expect(uploadOptions.signal.aborted).toBe(false);
    expect(uploadOptions.shouldFallback()).toBe(true);

    rendered.rerender(
      <TestingOverlay
        key="user-b"
        ref={ref}
        identityKey="user-b"
        onEvent={onEvent}
      />,
    );

    await waitFor(() => expect(uploadOptions.signal.aborted).toBe(true));
    expect(uploadOptions.shouldFallback()).toBe(false);
    await act(async () => {
      resolveUpload?.({ status: "uploaded", id: "recording-user-a" });
      await Promise.resolve();
    });
    expect(onEvent).not.toHaveBeenCalledWith("stopped");
  });

  it("aborts a pending session lookup and ignores the prior user's result", async () => {
    let resolveSession:
      | ((session: Record<string, unknown>) => void)
      | undefined;
    loadCurrentTestSessionSpy.mockImplementation(
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          resolveSession = resolve;
        }),
    );
    const onEvent = vi.fn();
    const ref = createRef<TestingOverlayHandle>();
    const rendered = render(
      <TestingOverlay
        key="user-a"
        ref={ref}
        identityKey="user-a"
        onEvent={onEvent}
      />,
    );

    act(() => ref.current?.open());
    fireEvent.click(screen.getByTestId("testing-overlay-start"));
    await waitFor(() =>
      expect(loadCurrentTestSessionSpy).toHaveBeenCalledTimes(1),
    );

    const loadOptions = loadCurrentTestSessionSpy.mock.calls[0]?.[1] as {
      signal: AbortSignal;
      shouldCache: () => boolean;
    };
    expect(loadOptions.signal.aborted).toBe(false);
    expect(loadOptions.shouldCache()).toBe(true);

    rendered.rerender(
      <TestingOverlay
        key="user-b"
        ref={ref}
        identityKey="user-b"
        onEvent={onEvent}
      />,
    );

    expect(loadOptions.signal.aborted).toBe(true);
    expect(loadOptions.shouldCache()).toBe(false);
    await act(async () => {
      resolveSession?.({
        id: "11111111-1111-4111-8111-111111111111",
        status: "active",
        microphoneConsentState: "granted",
      });
      await Promise.resolve();
    });

    expect(recordingServiceCtorSpy).not.toHaveBeenCalled();
    expect(recordingServiceStartSpy).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalledWith("started");
  });

  it("allows only one recorder start while permission work is pending", async () => {
    state.cachedSession = {
      id: "11111111-1111-4111-8111-111111111111",
      status: "active",
      microphoneConsentState: "granted",
    };
    let resolveStart: (() => void) | undefined;
    state.recordingStart = () =>
      new Promise<void>((resolve) => {
        resolveStart = resolve;
      });
    const onEvent = vi.fn();
    const ref = createRef<TestingOverlayHandle>();
    const rendered = render(
      <TestingOverlay
        key="user-a"
        ref={ref}
        identityKey="user-a"
        onEvent={onEvent}
      />,
    );

    act(() => ref.current?.open());
    const start = screen.getByTestId("testing-overlay-start");
    fireEvent.click(start);
    fireEvent.click(start);

    expect(recordingServiceCtorSpy).toHaveBeenCalledTimes(1);
    expect(recordingServiceStartSpy).toHaveBeenCalledTimes(1);

    rendered.rerender(
      <TestingOverlay
        key="user-b"
        ref={ref}
        identityKey="user-b"
        onEvent={onEvent}
      />,
    );
    await act(async () => {
      resolveStart?.();
      await Promise.resolve();
    });

    expect(recordingServiceCancelSpy).toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalledWith("started");
  });


});
