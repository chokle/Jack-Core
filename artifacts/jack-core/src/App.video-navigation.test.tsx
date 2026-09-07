// @vitest-environment jsdom
import React from "react";
import App from "./App";
import { FloatingJack } from "./components/FloatingJack";
import { askJack } from "@workspace/api-client-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  loadTelemetryContext,
  startTestSession,
  saveTelemetryConsents,
} from "./lib/user-testing/test-session-service";
import { loadCloseout } from "./lib/user-testing/end-of-shift-closeout-service";

vi.hoisted(() => vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_jack_ci"));
vi.mock("@clerk/react", () => ({
  AuthenticateWithRedirectCallback: () => null,
  SignUp: () => null,
  Show: ({ when, children }: { when: string; children: React.ReactNode }) =>
    when === "signed-in" ? <>{children}</> : null,
  useAuth: () => ({
    isLoaded: true,
    getToken: vi.fn(async () => "test-token"),
  }),
  useClerk: () => ({ addListener: () => () => {}, signOut: vi.fn() }),
}));
vi.mock("@clerk/react/internal", () => ({
  InternalClerkProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));
vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/api-client-react")>()),
  useGetMe: () => ({
    data: {
      userId: "participant-1",
      name: "Pilot Participant",
      email: "participant@example.test",
      isAdmin: false,
    },
  }),

  getMe: vi.fn(async () => ({ userId: "participant-1" })),
  listVideos: vi.fn(async () => ({
    videos: [{ id: "three-g", title: "3gdemo" }],
    total: 1,
  })),
  useGetVideo: (id: string) => ({
    data: {
      id,
      title: id === "three-g" ? "3gdemo" : "Oxy",
      status: "completed",
      videoUrl: "https://fixture.invalid/" + id + ".mp4",
      competencyCodes: [],
      segments: [],
      analysis: "Saved analysis",
    },
    isLoading: false,
  }),
  askJack: vi.fn(() => new Promise(() => {})),
  setAuthTokenGetter: vi.fn(),
}));

// Keep the real App, JackShell navigation, VideoDetail and FloatingJack.
// Unrelated pages and external service boundaries are isolated.
vi.mock("./components/Library", () => ({
  Library: ({ onSelectVideo }: { onSelectVideo: (id: string) => void }) => (
    <button onClick={() => onSelectVideo("oxy")}>Open Oxy</button>
  ),
}));
vi.mock("./components/Landing", () => ({ Landing: () => null }));
vi.mock("./components/KnowledgeGraph", () => ({ KnowledgeGraph: () => null }));
vi.mock("./components/MemoryGraphView", () => ({
  MemoryGraphView: () => null,
}));
vi.mock("./components/InterviewMode", () => ({ InterviewMode: () => null }));
vi.mock("./components/KnowledgeReview", () => ({
  KnowledgeReview: () => null,
}));

vi.mock("./components/AskJack", () => ({ AskJack: () => null }));
vi.mock("./components/PilotActivityReports", () => ({
  PilotActivityReports: () => null,
}));
vi.mock("./components/SystemHealthWidget", () => ({
  SystemHealthWidget: () => null,
}));
vi.mock("./components/testing/UserTestFeedback", () => ({
  UserTestFeedback: () => null,
}));
vi.mock("./lib/use-memory-graph", () => ({
  useMemoryGraphData: () => ({
    model: { counts: { nodes: 0, connections: 0, knowledge: 0, topics: 0 } },
    readyCount: 0,
    isLoading: false,
  }),
}));
vi.mock("@/lib/user-testing/recording-service", () => ({
  isScreenRecordingSupported: () => false,
  RecordingService: class RecordingService {},
}));
vi.mock("@/lib/user-testing/upload-service", () => ({
  uploadTestRecording: vi.fn(),
}));
vi.mock("./lib/user-testing/test-session-service", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("./lib/user-testing/test-session-service")
  >()),
  initializeTelemetryRetry: vi.fn(() => vi.fn()),
  loadTelemetryContext: vi.fn(),
  startTestSession: vi.fn(),
  saveTelemetryConsents: vi.fn(),
}));
vi.mock("./lib/user-testing/end-of-shift-closeout-service", () => ({
  loadCloseout: vi.fn(async () => ({
    scope: {
      actorUserId: "participant-1",
      organizationId: "server-org",
      pilotId: "server-pilot",
    },
    state: "not_started",
    closeout: null,
    crew: null,
    trade: null,
    availableQuestions: ["tasksCompleted"],
  })),
  saveCloseout: vi.fn(),
}));

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("natural video navigation through the real App", () => {
  it("switches actual VideoDetail through the App source event after interrupting", async () => {
    let finishOld!: (value: any) => void;
    vi.mocked(askJack).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("[]", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    let recognition: any;
    Object.defineProperty(window, "SpeechRecognition", {
      configurable: true,
      value: class {
        constructor() {
          recognition = this;
        }
        start() {}
        stop() {}
        abort() {}
      },
    });
    vi.mocked(loadTelemetryContext).mockResolvedValue({
      enrolled: false,
      requiresPilotSelection: false,
      scope: null,
      privacyScopes: [],
      consents: { telemetry: null, screen: null, microphone: null },
      session: null,
      privacyNoticeVersion: "privacy-v1",
      consentVersion: "consent-v1",
    });
    window.history.replaceState({}, "", "/app");
    render(
      <>
        <App />
        <FloatingJack />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Open menu" }));
    fireEvent.click(screen.getByRole("button", { name: /^Library$/ }));
    fireEvent.click(await screen.findByText("Open Oxy"));
    await screen.findByRole("heading", { name: /^Oxy$/ });
    fireEvent.click(screen.getByRole("button", { name: /^Transcript$/ }));
    const input = await screen.findByLabelText("Ask Jack");
    fireEvent.change(input, {
      target: { value: "Summarize what happened at 15 seconds" },
    });
    fireEvent.click(screen.getByLabelText("Send to Jack"));
    await waitFor(() => expect(askJack).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByLabelText("Talk to Jack"));
    await act(async () => {
      recognition.onresult({
        results: [{ 0: { transcript: "Take me to 3G demo" }, isFinal: true }],
      });
    });
    await screen.findByRole("heading", { name: /^3gdemo$/ });
    expect(
      document.querySelector(
        'video[src="https://fixture.invalid/three-g.mp4"]',
      ),
    ).toBeTruthy();
    expect(
      document
        .querySelector('[data-jack-surface="Video"]')
        ?.getAttribute("data-jack-path"),
    ).toContain("Transcript");
    await act(async () => {
      finishOld({ answer: "Stale Oxy response", citations: [] });
    });
    expect(screen.queryByText("Stale Oxy response")).toBeNull();
    expect(screen.getByText(/Jack is with you:/).textContent).toContain(
      "3gdemo",
    );
    expect(askJack).toHaveBeenCalledOnce();
  });
});
