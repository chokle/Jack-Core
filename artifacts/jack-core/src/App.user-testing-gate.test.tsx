// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";

interface MeProfile {
  userId: string;
  isAdmin: boolean;
  name: string;
  email: string;
}

const TEST_PREFIX_KEY = "jack.userTesting.declinedWithoutRecording.v1";

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
  return `${TEST_PREFIX_KEY}:${userId}`;
}

const modalCloseAfterStart = { value: false };
const recordingSupported = { value: false };
const rejectStart = { value: false };
const modalStartSpy = vi.fn();
const recordingServiceCtorSpy = vi.fn();
const recordingServiceStartSpy = vi.fn();
const uploadRecordingSpy = vi.fn(async () => ({ status: "uploaded" as const, filename: "fallback.webm" }));
let lastConsented: boolean | null = null;

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

    stop() {
      return Promise.resolve(null);
    }

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

vi.mock("@/components/ui/toaster", () => ({ Toaster: () => null }));
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

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
    if (typeof key === "string" && key.startsWith(TEST_PREFIX_KEY)) {
      throw new Error("storage blocked");
    }
    return originalSetItem.call(this, key, value);
  });
  return { setItemSpy };
}

describe("user-testing gate transition", () => {
  afterEach(() => {
    cleanup();
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
  });

  it("initial decline unlocks the app immediately", async () => {
    await declineWithoutRecording();

    expect(screen.queryByTestId("user-testing-restricted-gate")).toBeNull();
  });

  it("accepted remains false after continue without recording", async () => {
    await declineWithoutRecording();
    await waitFor(() => {
      expect(userConsented()).toBe("false");
    });
  });

  it("decline triggers no recording or testing side effects", async () => {
    await declineWithoutRecording();

    expect(recordingServiceCtorSpy).not.toHaveBeenCalled();
    expect(recordingServiceStartSpy).not.toHaveBeenCalled();
    expect(uploadRecordingSpy).not.toHaveBeenCalled();
  });

  it("opt-out is persisted for the authenticated user and survives remount", async () => {
    await declineWithoutRecording();

    const key = declinedStorageKey(identity.userId);
    expect(localStorage.getItem(key)).toBe("true");

    cleanup();
    await renderAuthenticatedApp();
    await waitFor(() => {
      expect(screen.queryByTestId("user-testing-restricted-gate")).toBeNull();
    });
    await waitFor(() => {
      expect(userConsented()).toBe("false");
    });
  });

  it("explicit initial decline writes the opt-out marker", async () => {
    const key = declinedStorageKey(identity.userId);

    await declineWithoutRecording();

    expect(localStorage.getItem(key)).toBe("true");
    expect(screen.queryByTestId("user-testing-restricted-gate")).toBeNull();
  });

  it("different users use user-scoped opt-out storage keys", async () => {
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
    });

    expect(localStorage.getItem(otherUserKey)).toBe("true");
    expect(firstUserKey).not.toBe(otherUserKey);
  });

  it("failed localStorage write does not block current-session unlock", async () => {
    const { setItemSpy } = storageWriteFailureForUserScope();

    await declineWithoutRecording();

    expect(screen.queryByTestId("user-testing-restricted-gate")).toBeNull();
    expect(localStorage.getItem(declinedStorageKey(identity.userId))).toBeNull();
    setItemSpy.mockRestore();
  });

  it("user can still start testing voluntarily after decline", async () => {
    recordingSupported.value = true;
    const key = declinedStorageKey(identity.userId);
    await declineWithoutRecording();
    expect(localStorage.getItem(key)).toBe("true");

    openFromAnyEntry();
    await startFlowFromOpenOverlay({ expectRecording: true });
    await waitFor(() => {
      expect(userConsented()).toBe("true");
    });
    expect(localStorage.getItem(key)).toBeNull();
  });

  it("late declined after unsupported-start does not write opt-out marker", async () => {
    recordingSupported.value = false;
    modalCloseAfterStart.value = true;
    const key = declinedStorageKey(identity.userId);

    await renderAndOpenInitialModal();
    openFromAnyEntry();
    await startFlowFromOpenOverlay();

    await waitFor(() => {
      expect(screen.queryByTestId("user-testing-restricted-gate")).toBeNull();
      expect(localStorage.getItem(key)).toBeNull();
    });
    await waitFor(() => {
      expect(userConsented()).toBe("true");
    });
  });

  it("remount follows the latest user-testing choice", async () => {
    recordingSupported.value = true;
    const key = declinedStorageKey(identity.userId);

    await declineWithoutRecording();
    expect(localStorage.getItem(key)).toBe("true");

    openFromAnyEntry();
    await startFlowFromOpenOverlay({ expectRecording: true });
    await waitFor(() => {
      expect(userConsented()).toBe("true");
      expect(localStorage.getItem(key)).toBeNull();
    });

    cleanup();
    await renderAuthenticatedApp();

    await waitFor(() => {
      expect(screen.queryByTestId("user-testing-restricted-gate")).toBeNull();
      expect(localStorage.getItem(key)).toBeNull();
    });
  });

  it("repeated continue actions are idempotent", async () => {
    await declineWithoutRecording();

    openFromAnyEntry();
    const cancel1 = await screen.findByTestId("user-testing-cancel");
    fireEvent.click(cancel1);

    openFromAnyEntry();
    const cancel2 = await screen.findByTestId("user-testing-cancel");
    fireEvent.click(cancel2);

    await waitFor(() => {
      expect(screen.queryByTestId("user-testing-restricted-gate")).toBeNull();
    });
    expect(localStorage.getItem(declinedStorageKey(identity.userId))).toBe("true");
  });

  it("unlocks unsupported recording and converges to no-gate state", async () => {
    recordingSupported.value = false;

    await renderAndOpenInitialModal();
    openFromAnyEntry();
    await screen.findByTestId("user-testing-start");
    fireEvent.click(screen.getByTestId("user-testing-start"));

    await waitFor(() => {
      expect(screen.queryByTestId("user-testing-restricted-gate")).toBeNull();
      expect(userConsented()).toBe("true");
    });
  });

  it("unlocks after permission denied without trapping the user", async () => {
    recordingSupported.value = true;
    rejectStart.value = true;

    await renderAndOpenInitialModal();
    openFromAnyEntry();
    await screen.findByTestId("user-testing-start");
    fireEvent.click(screen.getByTestId("user-testing-start"));

    await waitFor(() => {
      expect(screen.queryByTestId("user-testing-restricted-gate")).toBeNull();
      expect(userConsented()).toBe("true");
    });
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
