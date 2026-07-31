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

const identity: MeProfile = {
  userId: "user-test-gate-profile",
  isAdmin: false,
  name: "Authenticated User",
  email: "gate-test@torchlabs.ca",
};

const modalCloseAfterStart = { value: false };
const recordingSupported = { value: false };
const rejectStart = { value: false };
const modalStartSpy = vi.fn();

const toast = vi.fn();

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

vi.mock("./components/testing/UserTestFeedback", () => ({
  UserTestFeedback: () => <div data-testid="user-test-feedback" />,
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
      <div>
        <button type="button" data-testid="user-testing-start" onClick={() => {
          modalStartSpy();
          onStart();
          if (modalCloseAfterStart.value) {
            onCancel();
          }
        }}>
          Start Test
        </button>
        <button type="button" data-testid="user-testing-cancel" onClick={onCancel}>
          Continue Without Recording
        </button>
      </div>
    );
  },
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

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
      this.onStop = callbacks?.onStop as typeof this.onStop;
    }

    async start() {
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

vi.mock("@/components/ui/toaster", () => ({ Toaster: () => null }));
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

async function renderAuthenticatedApp(path = "/app?test=true") {
  window.history.replaceState({}, "", path);
  const module = await import("./App");
  return render(<module.default />);
}

async function openTestingGate() {
  cleanup();
  await renderAuthenticatedApp();
  const initialConsentCancel = await screen.findByTestId("user-testing-cancel");
  fireEvent.click(initialConsentCancel);
  await waitFor(() => {
    expect(screen.queryByTestId("user-testing-restricted-gate")).not.toBeNull();
  });
}

async function unlockViaRecordingGate() {
  fireEvent.click(screen.getByTestId("user-testing-gate-start"));
  const modalStartButton = await screen.findByTestId("user-testing-start");
  fireEvent.click(modalStartButton);
}

function clickSidebarStart() {
  fireEvent.click(screen.getByTestId("start-user-test"));
}

function clickAnyGateStart() {
  const gateStart = screen.queryByTestId("user-testing-gate-start");
  if (gateStart) {
    fireEvent.click(gateStart);
    return;
  }
  fireEvent.click(screen.getByTestId("start-user-test"));
}

describe("user-testing gate transition", () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.clearAllMocks();
    modalStartSpy.mockClear();
    modalCloseAfterStart.value = false;
    recordingSupported.value = false;
    rejectStart.value = false;
  });

  it("does not relock when a late declined event follows unsupported recording start", async () => {
    recordingSupported.value = false;
    modalCloseAfterStart.value = true;

    await openTestingGate();
    await unlockViaRecordingGate();

    await waitFor(() => {
      expect(screen.queryByTestId("user-testing-restricted-gate")).toBeNull();
    });
  });

  it("unlocks when unsupported recording becomes unavailable and starts", async () => {
    recordingSupported.value = false;
    modalCloseAfterStart.value = false;

    await openTestingGate();
    await unlockViaRecordingGate();

    await waitFor(() => {
      expect(screen.queryByTestId("user-testing-restricted-gate")).toBeNull();
    });
  });

  it("unlocks supported recording flow after permission is denied", async () => {
    recordingSupported.value = true;
    rejectStart.value = true;
    modalCloseAfterStart.value = false;

    await openTestingGate();
    await unlockViaRecordingGate();

    await waitFor(() => {
      expect(screen.queryByTestId("user-testing-restricted-gate")).toBeNull();
    });
  });

  it("unlocks supported recording flow after explicit cancel", async () => {
    recordingSupported.value = true;
    rejectStart.value = false;

    await openTestingGate();
    clickAnyGateStart();
    fireEvent.click(screen.getByTestId("user-testing-cancel"));

    await waitFor(() => {
      expect(screen.queryByTestId("user-testing-restricted-gate")).not.toBeNull();
    });

    clickAnyGateStart();
    fireEvent.click(await screen.findByTestId("user-testing-start"));

    await waitFor(() => {
      expect(screen.queryByTestId("user-testing-restricted-gate")).toBeNull();
    });
  });

  it("handles repeated Start presses idempotently", async () => {
    recordingSupported.value = false;

    await openTestingGate();
    fireEvent.click(screen.getByTestId("user-testing-gate-start"));
    fireEvent.click(await screen.findByTestId("user-testing-start"));
    await waitFor(() => {
      expect(screen.queryByTestId("user-testing-restricted-gate")).toBeNull();
    });

    await openTestingGate();
    fireEvent.click(screen.getByTestId("user-testing-gate-start"));
    fireEvent.click(await screen.findByTestId("user-testing-start"));

    await waitFor(() => {
      expect(screen.queryByTestId("user-testing-restricted-gate")).toBeNull();
    });

    expect(modalStartSpy).toHaveBeenCalledTimes(2);
  });

  it("converges page and sidebar entry points to the same unlock path", async () => {
    recordingSupported.value = false;

    await openTestingGate();
    fireEvent.click(screen.getByTestId("user-testing-gate-start"));
    fireEvent.click(await screen.findByTestId("user-testing-start"));
    await waitFor(() => {
      expect(screen.queryByTestId("user-testing-restricted-gate")).toBeNull();
    });

    await openTestingGate();
    clickSidebarStart();
    fireEvent.click(await screen.findByTestId("user-testing-start"));
    await waitFor(() => {
      expect(screen.queryByTestId("user-testing-restricted-gate")).toBeNull();
    });
  });
});
