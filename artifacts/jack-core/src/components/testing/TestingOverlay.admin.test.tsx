// @vitest-environment jsdom
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, fireEvent } from "@testing-library/react";
import { TestingOverlay, type TestingOverlayHandle } from "./TestingOverlay";

const state = vi.hoisted(() => ({
  cachedSession: null as null | Record<string, unknown>,
  currentSession: null as null | Record<string, unknown>,
}));

const recordingServiceCtorSpy = vi.fn();
const recordingServiceStartSpy = vi.fn();

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/user-testing/test-session-service", () => ({
  getCachedTestSession: () => state.cachedSession,
  loadCurrentTestSession: vi.fn(async () => state.currentSession),
  trackTestEvent: vi.fn(),
}));
vi.mock("@/lib/user-testing/recording-service", () => ({
  RecordingService: class {
    onStop?: () => void;
    constructor() {
      recordingServiceCtorSpy();
    }
    async start() {
      recordingServiceStartSpy();
    }
    stop() {
      return Promise.resolve();
    }
    cancel() {}
    pause() {}
    resume() {}
  },
  isScreenRecordingSupported: () => true,
}));
vi.mock("@/lib/user-testing/upload-service", () => ({ uploadTestRecording: vi.fn() }));
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
    recordingServiceCtorSpy.mockClear();
    recordingServiceStartSpy.mockClear();
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
});
