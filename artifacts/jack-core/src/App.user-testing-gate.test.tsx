// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import * as testSessionService from "@/lib/user-testing/test-session-service";

interface MeProfile {
  userId: string;
  isAdmin: boolean;
  name: string;
  email: string;
}

const ACTIVE_SESSION_KEY = "jack.userTesting.activeSession.v2";
const DECLINED_PREFIX_KEY = "jack.userTesting.declinedWithoutRecording.v1";
const ACCEPTED_PREFIX_KEY = "jack.userTesting.acceptedWithoutRecording.v1";

const identityBase: MeProfile = {
  userId: "user-test-gate-profile",
  isAdmin: false,
  name: "Authenticated User",
  email: "gate-test@torchlabs.ca",
};
let identity: MeProfile = { ...identityBase };

function setIdentity(next: MeProfile) {
  identity = next;
}

function declinedStorageKey(userId: string) {
  return `${DECLINED_PREFIX_KEY}:${userId}`;
}

function acceptedStorageKey(userId: string) {
  return `${ACCEPTED_PREFIX_KEY}:${userId}`;
}

const modalCloseAfterStart = { value: false };
const recordingSupported = { value: false };
const rejectStart = { value: false };
const startFailuresRemaining = { value: 0 };
const modalStartSpy = vi.fn();
const recordingServiceCtorSpy = vi.fn();
const recordingServiceStartSpy = vi.fn();
const uploadRecordingSpy = vi.fn(async () => ({ status: "uploaded" as const, filename: "fallback.webm" }));
let lastConsented: boolean | null = null;

const testSessionServiceState = {
  contextError: null as Error | null,
  currentSession: null as unknown,
  startedSession: {
    id: "11111111-1111-4111-8111-111111111111",
    organizationId: "org-test-1",
    pilotId: "pilot-test-1",
    appSessionId: "app-session-test-1",
    status: "active" as const,
    telemetryStatus: "granted" as const,
    screenConsentState: "granted" as const,
    microphoneConsentState: "granted" as const,
    onboardingStatus: "not_started" as const,
    onboardingStep: 0,
    recordingStatus: "not_started",
    feedbackStatus: "not_started",
    questionCount: 0,
    startedAt: "2026-07-31T00:00:00Z",
    lastActivityAt: "2026-07-31T00:00:00Z",
    expiresAt: "2026-07-31T12:00:00Z",
  },
  telemetryContext: {
    enrolled: true,
    requiresPilotSelection: false,
    scope: {
      organizationId: "org-test-1",
      pilotId: "pilot-test-1",
      organizationName: "Unit Org",
      pilotName: "Unit Pilot",
    },
    consents: {
      telemetry: {
        state: "granted",
        privacyNoticeVersion: "privacy-v1",
        consentVersion: "consent-v1",
      },
      screen: {
        state: "granted",
        privacyNoticeVersion: "privacy-v1",
        consentVersion: "consent-v1",
      },
      microphone: {
        state: "granted",
        privacyNoticeVersion: "privacy-v1",
        consentVersion: "consent-v1",
      },
    },
    session: null,
    privacyNoticeVersion: "privacy-v1",
    consentVersion: "consent-v1",
  },
  saveTelemetryResult: {
    enrolled: true,
    requiresPilotSelection: false,
    scope: {
      organizationId: "org-test-1",
      pilotId: "pilot-test-1",
      organizationName: "Unit Org",
      pilotName: "Unit Pilot",
    },
    consents: {
      telemetry: {
        state: "granted",
        privacyNoticeVersion: "privacy-v1",
        consentVersion: "consent-v1",
      },
      screen: {
        state: "granted",
        privacyNoticeVersion: "privacy-v1",
        consentVersion: "consent-v1",
      },
      microphone: {
        state: "granted",
        privacyNoticeVersion: "privacy-v1",
        consentVersion: "consent-v1",
      },
    },
    session: null,
    privacyNoticeVersion: "privacy-v1",
    consentVersion: "consent-v1",
  },
};

function cloneTelemetryContext() {
  return JSON.parse(JSON.stringify(testSessionServiceState.telemetryContext));
}

function cloneStartedSession() {
  return JSON.parse(JSON.stringify(testSessionServiceState.startedSession));
}

function setCachedActiveSession(overrides: Partial<typeof testSessionServiceState.startedSession> = {}) {
  const session = {
    ...testSessionServiceState.startedSession,
    ...overrides,
  };
  sessionStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(session));
  return session;
}

// Ensure Clerk and app env are available in the test runtime.
vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_jack_ci");

vi.mock("@clerk/react", () => ({
  AuthenticateWithRedirectCallback: () => null,
  SignUp: () => null,
  Show: ({ when, children }: { when: "signed-in" | "signed-out"; children: React.ReactNode }) => {
    if (when === "signed-in") return <>{children}</>;
    return null;
  },
  useAuth: () => ({ isLoaded: true, getToken: vi.fn(async () => "test-token") }),
  useClerk: () => ({
    addListener: () => () => {},
    signOut: vi.fn(),
  }),
}));

vi.mock("@clerk/react/internal", () => ({
  InternalClerkProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@workspace/api-client-react", async () => {
  const actual = await vi.importActual<typeof import("@workspace/api-client-react")>(
    "@workspace/api-client-react",
  );
  return {
    ...actual,
    useGetMe: () => ({ data: identity }),
    setAuthTokenGetter: vi.fn(),
  };
});

vi.mock("./components/Landing", () => ({ Landing: () => <div data-testid="landing-page" /> }));
vi.mock("./components/KnowledgeGraph", () => ({ KnowledgeGraph: () => <div data-testid="knowledge-graph" /> }));
vi.mock("./components/MemoryGraphView", () => ({ MemoryGraphView: () => <div data-testid="memory-graph-view" /> }));
vi.mock("./components/Library", () => ({ Library: () => <div data-testid="library-page" /> }));
vi.mock("./components/InterviewMode", () => ({ InterviewMode: () => <div data-testid="interview-page" /> }));
vi.mock("./components/KnowledgeReview", () => ({ KnowledgeReview: () => <div data-testid="knowledge-review-page" /> }));
vi.mock("./components/VideoDetail", () => ({
  VideoDetail: () => <div data-testid="video-detail-page" />,
}));
vi.mock("./components/AskJack", () => ({
  AskJack: () => <div data-testid="ask-jack-page" />,
}));
vi.mock("./components/SystemHealthWidget", () => ({
  SystemHealthWidget: () => <div data-testid="system-health" />,
}));

vi.mock("./components/testing/UserTestFeedback", () => ({
  UserTestFeedback: ({ consented }: { consented: boolean }) => {
    lastConsented = consented;
    return <div data-testid="user-test-feedback" data-consented={String(consented)} />;
  },
}));

vi.mock("./components/testing/UserTestingModal", () => ({
  UserTestingModal: ({
    open,
    onStart,
    onCancel,
  }: {
    open: boolean;
    onStart: () => void;
    onCancel: () => void;
  }) => {
    if (!open) return null;
    return (
      <div data-testid="user-testing-modal">
        <button
          type="button"
          data-testid="user-testing-start"
          onClick={() => {
            modalStartSpy();
            onStart();
            if (modalCloseAfterStart.value) {
              onCancel();
            }
          }}
        >
          Start Test
        </button>
        <button type="button" data-testid="user-testing-cancel" onClick={onCancel}>
          Continue Without Recording
        </button>
      </div>
    );
  },
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

vi.mock("./lib/use-memory-graph", () => ({
  useMemoryGraphData: () => ({
    model: {
      counts: {
        nodes: 0,
        connections: 0,
        knowledge: 0,
        topics: 0,
      },
    },
    readyCount: 0,
    isLoading: false,
    lastUpdated: "2026-07-31T00:00:00Z",
  }),
}));

vi.mock("@/lib/user-testing/recording-service", () => {
  class RecordingService {
    onStop?: (result: {
      blob: Blob;
      mimeType: string;
      durationMs: number;
      screenResolution: string;
      micIncluded: boolean;
      stopReason: "user" | "native-stop-sharing" | "error";
    }) => void;

    constructor(callbacks?: { onStop?: (result: unknown) => void }) {
      recordingServiceCtorSpy();
      this.onStop = callbacks?.onStop as typeof this.onStop;
    }

    async start() {
      recordingServiceStartSpy();
      if (rejectStart.value) {
        throw new Error("recording permission denied");
      }
    }

    get micIncluded() {
      return true;
    }

    elapsedMs() {
      return 0;
    }

    stop() {
      return Promise.resolve(null);
    }

    cancel() {}
    pause() {}
    resume() {}
  }

  return {
    isScreenRecordingSupported: () => recordingSupported.value,
    RecordingService,
  };
});

vi.mock("@/lib/user-testing/upload-service", () => ({
  uploadTestRecording: async () => uploadRecordingSpy(),
}));

vi.mock("@/lib/user-testing/test-session-service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/user-testing/test-session-service")>(
    "@/lib/user-testing/test-session-service",
  );
  return {
    ...actual,
    initializeTelemetryRetry: vi.fn(() => vi.fn()),
    loadTelemetryContext: vi.fn(async () => {
      if (testSessionServiceState.contextError) {
        throw testSessionServiceState.contextError;
      }
      return cloneTelemetryContext();
    }),
    saveTelemetryConsents: vi.fn(async () => {
      return JSON.parse(JSON.stringify(testSessionServiceState.saveTelemetryResult));
    }),
    startTestSession: vi.fn(async () => {
      if (startFailuresRemaining.value > 0) {
        startFailuresRemaining.value -= 1;
        throw new Error("temporary session start failure");
      }
      const session = cloneStartedSession();
      actual.cacheTestSession(session);
      return session;
    }),
    loadCurrentTestSession: vi.fn(async () =>
      testSessionServiceState.currentSession
        ? (JSON.parse(JSON.stringify(testSessionServiceState.currentSession)) as unknown)
        : null,
    ),
    trackTestEvent: vi.fn(),
    withdrawTelemetry: vi.fn(async () => ({
      withdrawn: ["telemetry"],
      deletionDueAt: null,
    })),
    exportTelemetry: vi.fn(),
  };
});

vi.mock("@/components/ui/toaster", () => ({ Toaster: () => null }));
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const mockedLoadCurrentSession = vi.mocked(testSessionService.loadCurrentTestSession);
const mockedLoadTelemetryContext = vi.mocked(testSessionService.loadTelemetryContext);
const mockedSaveTelemetryConsents = vi.mocked(testSessionService.saveTelemetryConsents);
const mockedStartTestSession = vi.mocked(testSessionService.startTestSession);
const mockedTrackTestEvent = vi.mocked(testSessionService.trackTestEvent);
const mockedWithdrawTelemetry = vi.mocked(testSessionService.withdrawTelemetry);
const mockedExportTelemetry = vi.mocked(testSessionService.exportTelemetry);

async function renderAuthenticatedApp(path = "/app?test=true") {
  window.history.replaceState({}, "", path);
  const module = await import("./App");
  return render(<module.default />);
}

function userConsented() {
  return screen.getByTestId("user-test-feedback").getAttribute("data-consented");
}

async function renderAndOpenInitialModal() {
  await renderAuthenticatedApp();
  const modalCancel = await screen.findByTestId("user-testing-cancel");
  return modalCancel;
}

async function declineWithoutRecording() {
  const cancel = await renderAndOpenInitialModal();
  fireEvent.click(cancel);
  await waitFor(() => expect(screen.queryByTestId("user-testing-modal")).toBeNull());
  await waitFor(() => {
    expect(screen.queryByTestId("user-testing-restricted-gate")).toBeNull();
  });
}

function openFromAnyEntry() {
  const gateStart = screen.queryByTestId("user-testing-gate-start");
  if (gateStart) {
    fireEvent.click(gateStart);
    return;
  }
  fireEvent.click(screen.getByTestId("start-user-test"));
}

function storageWriteFailureForUserScope() {
  const originalSetItem = Storage.prototype.setItem;
  const setItemSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage,
    key: string,
    value: string,
  ) {
    if (typeof key === "string" && key.startsWith(DECLINED_PREFIX_KEY)) {
      throw new Error("storage blocked");
    }
    return originalSetItem.call(this, key, value);
  });
  return { setItemSpy };
}

function resetServiceState() {
  testSessionServiceState.contextError = null;
  testSessionServiceState.currentSession = null;
  const mutableContext = testSessionServiceState.telemetryContext as unknown as Record<string, unknown>;
  delete mutableContext["privacyScopes"];
  Object.assign(mutableContext, {
    enrolled: true,
    requiresPilotSelection: false,
    scope: {
      organizationId: "org-test-1",
      pilotId: "pilot-test-1",
      organizationName: "Unit Org",
      pilotName: "Unit Pilot",
    },
    consents: {
      telemetry: {
        state: "granted",
        privacyNoticeVersion: "privacy-v1",
        consentVersion: "consent-v1",
      },
      screen: {
        state: "granted",
        privacyNoticeVersion: "privacy-v1",
        consentVersion: "consent-v1",
      },
      microphone: {
        state: "granted",
        privacyNoticeVersion: "privacy-v1",
        consentVersion: "consent-v1",
      },
    },
    session: null,
    privacyNoticeVersion: "privacy-v1",
    consentVersion: "consent-v1",
  });
  startFailuresRemaining.value = 0;
  mockedLoadCurrentSession.mockClear();
  mockedLoadTelemetryContext.mockClear();
  mockedSaveTelemetryConsents.mockClear();
  mockedStartTestSession.mockClear();
  mockedTrackTestEvent.mockClear();
  mockedWithdrawTelemetry.mockClear();
  mockedExportTelemetry.mockClear();
}

describe("user-testing gate transition", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    sessionStorage.clear();
    localStorage.clear();
    vi.clearAllMocks();
    modalStartSpy.mockClear();
    recordingServiceStartSpy.mockClear();
    recordingServiceCtorSpy.mockClear();
    uploadRecordingSpy.mockClear();
    lastConsented = null;
    setIdentity({ ...identityBase });
    modalCloseAfterStart.value = false;
    recordingSupported.value = false;
    rejectStart.value = false;
    resetServiceState();
  });

  it("initial decline unlocks the app and stays rejected, with zero testing side effects", async () => {
    await declineWithoutRecording();

    expect(screen.queryByTestId("user-testing-restricted-gate")).toBeNull();
    expect(userConsented()).toBe("false");
    // Current telemetry consent bootstraps exactly one scoped session on login
    // without treating that as screen-recording participation acceptance.
    expect(mockedStartTestSession).toHaveBeenCalledTimes(1);
    expect(recordingServiceCtorSpy).not.toHaveBeenCalled();
    expect(recordingServiceStartSpy).not.toHaveBeenCalled();
    expect(uploadRecordingSpy).not.toHaveBeenCalled();
  });

  it("decline persists user-scoped opt-out and remains true after remount", async () => {
    await declineWithoutRecording();
    const key = declinedStorageKey(identity.userId);
    expect(localStorage.getItem(key)).toBe("true");

    cleanup();
    await renderAuthenticatedApp();
    await waitFor(() => {
      expect(screen.queryByTestId("user-testing-restricted-gate")).toBeNull();
      expect(userConsented()).toBe("false");
      expect(localStorage.getItem(key)).toBe("true");
    });
  });

  it("different users use user-scoped opt-out keys", async () => {
    await declineWithoutRecording();
    const firstUserKey = declinedStorageKey(identity.userId);
    expect(localStorage.getItem(firstUserKey)).toBe("true");

    setIdentity({
      userId: "other-user-profile",
      isAdmin: false,
      name: "Other User",
      email: "other@torchlabs.ca",
    });

    cleanup();
    const otherUserKey = declinedStorageKey(identity.userId);
    await renderAuthenticatedApp();
    const cancel = await screen.findByTestId("user-testing-cancel");
    expect(localStorage.getItem(otherUserKey)).toBeNull();

    fireEvent.click(cancel);
    await waitFor(() => {
      expect(screen.queryByTestId("user-testing-restricted-gate")).toBeNull();
      expect(userConsented()).toBe("false");
    });

    expect(localStorage.getItem(otherUserKey)).toBe("true");
    expect(firstUserKey).not.toBe(otherUserKey);
  });

  it("storage write failures do not block current-session unlock", async () => {
    const { setItemSpy } = storageWriteFailureForUserScope();

    await declineWithoutRecording();

    expect(screen.queryByTestId("user-testing-restricted-gate")).toBeNull();
    expect(localStorage.getItem(declinedStorageKey(identity.userId))).toBeNull();
    setItemSpy.mockRestore();
  });

  it("start button still works without cached session by creating/discovering server session first", async () => {
    recordingSupported.value = true;

    await renderAuthenticatedApp("/app");
    fireEvent.click(screen.getByTestId("start-user-test"));

    await waitFor(() => {
      expect(mockedStartTestSession).toHaveBeenCalledTimes(1);
    });
    expect(userConsented()).toBe("false");
    await screen.findByTestId("user-testing-cancel");

    await startFlowFromOpenOverlay({ expectRecording: true });
    await waitFor(() => {
      expect(userConsented()).toBe("true");
    });
  });

  it("auto-bootstrap creates the telemetry session before explicit recording start", async () => {
    recordingSupported.value = true;
    testSessionServiceState.currentSession = null;

    await renderAndOpenInitialModal();
    await waitFor(() => expect(mockedStartTestSession).toHaveBeenCalledTimes(1));
    expect(userConsented()).toBe("false");
    expect(recordingServiceCtorSpy).not.toHaveBeenCalled();

    await startFlowFromOpenOverlay({ expectRecording: true });

    await waitFor(() => {
      expect(screen.queryByTestId("user-testing-restricted-gate")).toBeNull();
      expect(userConsented()).toBe("true");
    });
    expect(recordingServiceStartSpy).toHaveBeenCalledTimes(1);
    expect(uploadRecordingSpy).not.toHaveBeenCalled();
  });

  it("automatic telemetry consent stays separate from recording acceptance", async () => {
    testSessionServiceState.telemetryContext.consents.telemetry.privacyNoticeVersion =
      "privacy-stale";

    await renderAuthenticatedApp("/app");
    const modal = await screen.findByTestId("telemetry-consent-modal");
    fireEvent.click(within(modal).getAllByRole("checkbox")[0]);
    fireEvent.click(within(modal).getByRole("button", { name: "Save choices" }));

    await waitFor(() => expect(mockedSaveTelemetryConsents).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockedStartTestSession).toHaveBeenCalledTimes(1));

    expect(userConsented()).toBe("false");
    expect(localStorage.getItem(acceptedStorageKey(identity.userId))).toBeNull();
    expect(recordingServiceCtorSpy).not.toHaveBeenCalled();
    expect(recordingServiceStartSpy).not.toHaveBeenCalled();
  });

  it("automatic telemetry bootstrap preserves a Torch interview handoff", async () => {
    await renderAuthenticatedApp(
      "/app?view=interview&source=torch-command-centre&starvingPointId=sp-1&title=Boiler+check&trade=Plumbing",
    );

    await waitFor(() => expect(mockedStartTestSession).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("interview-page")).toBeTruthy();
    expect(screen.queryByTestId("memory-graph-view")).toBeNull();
  });

  it("retries a transient automatic session-start failure without dropping context", async () => {
    startFailuresRemaining.value = 1;

    await renderAuthenticatedApp("/app");

    await waitFor(() => expect(mockedStartTestSession).toHaveBeenCalledTimes(2), {
      timeout: 3_000,
    });
    expect(screen.getByTestId("memory-graph-view")).toBeTruthy();
    expect(userConsented()).toBe("false");

    openFromAnyEntry();
    await screen.findByTestId("user-testing-cancel");
    expect(mockedStartTestSession).toHaveBeenCalledTimes(2);
  });

  it("keeps retrying automatic bootstrap beyond the initial backoff window", async () => {
    vi.useFakeTimers();
    startFailuresRemaining.value = 6;

    await renderAuthenticatedApp("/app");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockedStartTestSession).toHaveBeenCalledTimes(1);

    const retryDelays = [500, 1_500, 3_000, 10_000, 30_000, 30_000];
    for (const [index, delay] of retryDelays.entries()) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delay);
      });
      expect(mockedStartTestSession).toHaveBeenCalledTimes(index + 2);
    }

    expect(mockedStartTestSession.mock.calls[6]?.[1]?.requestKey).toBe(identity.userId);
    vi.useRealTimers();
  });

  it("aborts the old identity bootstrap and starts a separately keyed request", async () => {
    let firstSignal: AbortSignal | undefined;
    mockedStartTestSession.mockImplementationOnce(
      (_pilotId, options) =>
        new Promise((_, reject) => {
          firstSignal = options?.signal;
          options?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );

    const rendered = await renderAuthenticatedApp("/app");
    await waitFor(() => expect(mockedStartTestSession).toHaveBeenCalledTimes(1));
    expect(mockedStartTestSession.mock.calls[0]?.[1]?.requestKey).toBe(
      identityBase.userId,
    );

    const nextIdentity = {
      userId: "other-user-profile",
      isAdmin: false,
      name: "Other User",
      email: "other@torchlabs.ca",
    };
    setIdentity(nextIdentity);
    const module = await import("./App");
    rendered.rerender(<module.default />);

    await waitFor(() => expect(firstSignal?.aborted).toBe(true));
    await waitFor(() => expect(mockedStartTestSession).toHaveBeenCalledTimes(2));
    expect(mockedStartTestSession.mock.calls[1]?.[1]?.requestKey).toBe(
      nextIdentity.userId,
    );
  });

  it("aborts and clears an automatic bootstrap when telemetry is withdrawn", async () => {
    let bootstrapSignal: AbortSignal | undefined;
    mockedStartTestSession.mockImplementationOnce(
      (_pilotId, options) =>
        new Promise((_, reject) => {
          bootstrapSignal = options?.signal;
          options?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );

    await renderAuthenticatedApp("/app");
    await waitFor(() => expect(mockedStartTestSession).toHaveBeenCalledTimes(1));
    expect(bootstrapSignal?.aborted).toBe(false);

    setCachedActiveSession();
    window.dispatchEvent(
      new CustomEvent("jack:telemetry-withdrawn", {
        detail: { withdrawn: ["telemetry"], deletionDueAt: null },
      }),
    );

    await waitFor(() => expect(bootstrapSignal?.aborted).toBe(true));
    expect(sessionStorage.getItem(ACTIVE_SESSION_KEY)).toBeNull();
    expect(mockedStartTestSession).toHaveBeenCalledTimes(1);
  });

  it("closes another user's consent prompt when the Clerk identity changes", async () => {
    testSessionServiceState.telemetryContext.consents.telemetry.privacyNoticeVersion =
      "privacy-stale";

    const rendered = await renderAuthenticatedApp("/app");
    await screen.findByTestId("telemetry-consent-modal");

    setIdentity({
      userId: "other-user-profile",
      isAdmin: false,
      name: "Other User",
      email: "other@torchlabs.ca",
    });
    testSessionServiceState.telemetryContext.consents.telemetry.privacyNoticeVersion =
      "privacy-v1";
    const module = await import("./App");
    rendered.rerender(<module.default />);

    await waitFor(() => {
      expect(screen.queryByTestId("telemetry-consent-modal")).toBeNull();
    });
  });

  it("resets recording acceptance during a same-tab account switch", async () => {
    localStorage.setItem(acceptedStorageKey(identity.userId), "true");
    const rendered = await renderAuthenticatedApp("/app");

    await waitFor(() => expect(userConsented()).toBe("true"));

    const nextIdentity = {
      userId: "other-user-profile",
      isAdmin: false,
      name: "Other User",
      email: "other@torchlabs.ca",
    };
    setIdentity(nextIdentity);
    const module = await import("./App");
    rendered.rerender(<module.default />);

    await waitFor(() => {
      expect(userConsented()).toBe("false");
      expect(screen.getByTestId("user-testing-restricted-gate")).toBeTruthy();
    });
    expect(localStorage.getItem(acceptedStorageKey(nextIdentity.userId))).toBeNull();
  });

  it("keeps export and withdrawal controls for a former tester's historical pilot", async () => {
    localStorage.setItem(acceptedStorageKey(identity.userId), "true");
    Object.assign(
      testSessionServiceState.telemetryContext as unknown as Record<string, unknown>,
      {
        enrolled: false,
        requiresPilotSelection: false,
        scope: null,
        privacyScopes: [
          {
            organizationId: "org-history-1",
            pilotId: "pilot-history-1",
            organizationName: "Former Org",
            pilotName: "Completed Pilot",
            consents: {
              telemetry: {
                state: "granted",
                privacyNoticeVersion: "privacy-v1",
                consentVersion: "consent-v1",
              },
              screen: {
                state: "withdrawn",
                privacyNoticeVersion: "privacy-v1",
                consentVersion: "consent-v1",
              },
              microphone: {
                state: "withdrawn",
                privacyNoticeVersion: "privacy-v1",
                consentVersion: "consent-v1",
              },
            },
          },
        ],
        consents: { telemetry: null, screen: null, microphone: null },
        session: null,
      },
    );

    await renderAuthenticatedApp("/app");
    await waitFor(() => expect(mockedLoadTelemetryContext).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId("account-settings"));

    const controls = await screen.findByTestId("telemetry-privacy-controls");
    expect(within(controls).getByText("Completed Pilot")).toBeTruthy();
    expect(within(controls).getByText("Former Org")).toBeTruthy();
    fireEvent.click(within(controls).getByRole("button", { name: "Export telemetry" }));
    expect(mockedExportTelemetry).toHaveBeenCalledTimes(1);

    const historicalScope = within(
      screen.getByTestId("telemetry-privacy-scope-pilot-history-1"),
    );
    fireEvent.click(
      historicalScope.getByRole("button", { name: "Withdraw telemetry" }),
    );

    await waitFor(() => {
      expect(mockedWithdrawTelemetry).toHaveBeenCalledWith(
        "pilot-history-1",
        ["telemetry"],
      );
    });
    expect(mockedLoadTelemetryContext.mock.calls.at(-1)?.[0]).toBeUndefined();
  });

  it("start with explicit active session records user testing acceptance", async () => {
    recordingSupported.value = true;
    setCachedActiveSession({ microphoneConsentState: "granted" });

    await renderAndOpenInitialModal();
    openFromAnyEntry();
    await startFlowFromOpenOverlay({ expectRecording: true });

    await waitFor(() => {
      expect(userConsented()).toBe("true");
    });
    expect(localStorage.getItem(acceptedStorageKey(identity.userId))).toBe("true");
    expect(localStorage.getItem(declinedStorageKey(identity.userId))).toBeNull();
  });

  it("missing telemetry context does not trap user", async () => {
    testSessionServiceState.contextError = new Error("telemetry context failed");
    await renderAuthenticatedApp("/app");

    fireEvent.click(screen.getByTestId("start-user-test"));
    const cancel = await screen.findByTestId("user-testing-cancel");
    fireEvent.click(cancel);

    await waitFor(() => {
      expect(screen.queryByTestId("user-testing-restricted-gate")).toBeNull();
      expect(userConsented()).toBe("false");
    });
    expect(recordingServiceCtorSpy).not.toHaveBeenCalled();
  });

  it("permission denied cannot set UserTestFeedback consent", async () => {
    recordingSupported.value = true;
    rejectStart.value = true;
    setCachedActiveSession();

    await renderAndOpenInitialModal();
    await startFlowFromOpenOverlay();

    await waitFor(() => {
      expect(screen.queryByTestId("user-testing-modal")).toBeNull();
      expect(screen.queryByTestId("user-testing-restricted-gate")).toBeNull();
      expect(userConsented()).toBe("false");
    });
    expect(uploadRecordingSpy).not.toHaveBeenCalled();
  });

  it("unavailable recording unlocks safely without upload or consent acceptance", async () => {
    recordingSupported.value = false;
    setCachedActiveSession();

    await renderAndOpenInitialModal();
    await startFlowFromOpenOverlay();

    await waitFor(() => {
      expect(screen.queryByTestId("user-testing-restricted-gate")).toBeNull();
      expect(userConsented()).toBe("false");
    });
    expect(uploadRecordingSpy).not.toHaveBeenCalled();
    expect(recordingServiceCtorSpy).not.toHaveBeenCalled();
  });

  it("late declined must not overwrite accepted recording consent", async () => {
    recordingSupported.value = true;
    modalCloseAfterStart.value = true;
    setCachedActiveSession();

    await renderAndOpenInitialModal();
    openFromAnyEntry();
    await startFlowFromOpenOverlay();

    await waitFor(() => {
      expect(screen.queryByTestId("user-testing-restricted-gate")).toBeNull();
      expect(userConsented()).toBe("true");
    });
    expect(localStorage.getItem(declinedStorageKey(identity.userId))).toBeNull();
  });

  it("repeated continue actions remain idempotent", async () => {
    testSessionServiceState.contextError = new Error("telemetry context unavailable");
    await declineWithoutRecording();

    fireEvent.click(screen.getByTestId("start-user-test"));
    const cancel1 = await screen.findByTestId("user-testing-cancel");
    fireEvent.click(cancel1);

    fireEvent.click(screen.getByTestId("start-user-test"));
    const cancel2 = await screen.findByTestId("user-testing-cancel");
    fireEvent.click(cancel2);

    await waitFor(() => {
      expect(screen.queryByTestId("user-testing-restricted-gate")).toBeNull();
      expect(userConsented()).toBe("false");
      expect(localStorage.getItem(declinedStorageKey(identity.userId))).toBe("true");
    });
  });

  it("remount follows latest user-testing choice", async () => {
    recordingSupported.value = true;
    await declineWithoutRecording();

    openFromAnyEntry();
    setCachedActiveSession();
    await startFlowFromOpenOverlay({ expectRecording: true });
    await waitFor(() => expect(userConsented()).toBe("true"));

    cleanup();
    await renderAuthenticatedApp();
    await waitFor(() => {
      expect(screen.queryByTestId("user-testing-restricted-gate")).toBeNull();
    });
    expect(screen.queryByTestId("user-test-feedback")).toBeTruthy();
    expect(userConsented()).toBe("true");
  });
});

async function startFlowFromOpenOverlay(options: { expectRecording?: boolean } = {}) {
  const { expectRecording = false } = options;
  const start = await screen.findByTestId("user-testing-start");
  const prevCtorCalls = recordingServiceCtorSpy.mock.calls.length;
  fireEvent.click(start);

  if (expectRecording) {
    await waitFor(() => {
      expect(recordingServiceCtorSpy).toHaveBeenCalledTimes(prevCtorCalls + 1);
    });
  }
}
