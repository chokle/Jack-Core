// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
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

vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_jack_ci");
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
  setAuthTokenGetter: vi.fn(),
}));

// Keep the real App, JackShell navigation, and Closeout form. Unrelated pages
// and external service boundaries are isolated so no telemetry is needed.
vi.mock("./components/Library", () => ({
  Library: () => <div>Participant library</div>,
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
vi.mock("./components/VideoDetail", () => ({ VideoDetail: () => null }));
vi.mock("./components/AskJack", () => ({ AskJack: () => null }));
vi.mock("./components/PilotActivityReports", () => ({
  PilotActivityReports: () => null,
}));
vi.mock("./components/SystemHealthWidget", () => ({
  SystemHealthWidget: () => null,
}));
vi.mock("./components/testing/TestingOverlay", () => ({
  TestingOverlay: () => null,
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
});

describe("participant Closeout navigation without telemetry", () => {
  it.each(["unavailable", "unenrolled"] as const)(
    "opens the real Closeout form when telemetry is %s",
    async (context) => {
      if (context === "unavailable") {
        vi.mocked(loadTelemetryContext).mockRejectedValue(
          new Error("Telemetry unavailable"),
        );
      } else {
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
      }
      window.history.replaceState({}, "", "/app");
      const { default: App } = await import("./App");
      render(<App />);
      await waitFor(() => expect(loadTelemetryContext).toHaveBeenCalled());
      fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
      fireEvent.click(screen.getByRole("button", { name: /^Library$/ }));
      expect(screen.getByText("Participant library")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
      fireEvent.click(screen.getByRole("button", { name: /^Closeout$/ }));
      await waitFor(() =>
        expect(screen.getByLabelText("Organization")).toHaveProperty(
          "value",
          "server-org",
        ),
      );
      expect(screen.getByLabelText("Participant ID")).toHaveProperty(
        "value",
        "participant-1",
      );
      expect(
        screen.getByLabelText("Participant", { exact: true }),
      ).toHaveProperty("value", "Pilot Participant");
      expect(
        screen.getByLabelText("What tasks were completed today?"),
      ).toBeTruthy();
      expect(screen.queryByText("Participant library")).toBeNull();
      expect(loadCloseout).toHaveBeenCalledWith({
        workDate: expect.any(String),
        shift: "day",
      });
      expect(startTestSession).not.toHaveBeenCalled();
      expect(saveTelemetryConsents).not.toHaveBeenCalled();
    },
  );
});
