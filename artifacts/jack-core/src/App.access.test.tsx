// @vitest-environment jsdom
import React from "react";
import App from "./App";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

const h = vi.hoisted(() => {
  vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_jack_ci");
  return {
    fetch: vi.fn(),
    graph: vi.fn(),
    tokenReady: false,
    canInvite: false,
  };
});
vi.mock("@clerk/react", () => ({
  AuthenticateWithRedirectCallback: () => null,
  SignIn: () => null,
  SignUp: () => null,
  Show: ({ when, children }: { when: string; children: React.ReactNode }) =>
    when === "signed-in" ? <>{children}</> : null,
  useAuth: () => ({
    isLoaded: true,
    userId: "member-a",
    sessionId: "session-a",
    getToken: async () => "token",
  }),
  useClerk: () => ({
    addListener: () => () => {},
    signOut: vi.fn(),
    openUserProfile: vi.fn(),
  }),
}));
vi.mock("@clerk/react/internal", () => ({
  InternalClerkProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));
vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/api-client-react")>()),
  customFetch: h.fetch,
  setAuthTokenGetter: (value: unknown) => {
    h.tokenReady = !!value;
  },
  useGetMe: () => ({
    data: {
      userId: "member-a",
      name: "Member",
      email: "member@example.test",
      isAdmin: false,
    },
  }),
}));
vi.mock("./lib/use-memory-graph", () => ({ useMemoryGraphData: h.graph }));
vi.mock("./components/Landing", () => ({ Landing: () => null }));
vi.mock("./components/KnowledgeGraph", () => ({ KnowledgeGraph: () => null }));
vi.mock("./components/MemoryGraphView", () => ({
  MemoryGraphView: () => <div>Member Living Memory</div>,
}));
vi.mock("./components/Library", () => ({ Library: () => null }));
vi.mock("./components/InterviewMode", () => ({ InterviewMode: () => null }));
vi.mock("./components/KnowledgeReview", () => ({
  KnowledgeReview: () => null,
}));
vi.mock("./components/VideoDetail", () => ({ VideoDetail: () => null }));
vi.mock("./components/AskJack", () => ({
  AskJack: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div>Ask Jack is open</div> : null,
}));
vi.mock("./components/SystemHealthWidget", () => ({
  SystemHealthWidget: () => null,
}));
vi.mock("./components/testing/UserTestFeedback", () => ({
  UserTestFeedback: () => null,
}));
vi.mock("./lib/user-testing/test-session-service", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("./lib/user-testing/test-session-service")
  >()),
  initializeTelemetryRetry: vi.fn(() => vi.fn()),
  loadTelemetryContext: vi.fn(async () => ({
    enrolled: false,
    scope: null,
    privacyScopes: [],
    consents: { telemetry: null, screen: null, microphone: null },
    session: null,
  })),
}));
beforeEach(() => {
  vi.clearAllMocks();
  h.canInvite = false;
  h.tokenReady = false;
  window.history.replaceState({}, "", "/app");
  h.graph.mockReturnValue({
    model: { counts: { nodes: 0, connections: 0, knowledge: 0, topics: 0 } },
    readyCount: 0,
    isLoading: false,
  });
  h.fetch.mockImplementation(async (path) => {
    expect(h.tokenReady).toBe(true);
    if (path === "/api/access/accept")
      return {
        allowed: true,
        canInvite: h.canInvite,
        organizations: [{ id: "org-a", name: "Org A", role: "champion" }],
      };
    if (path === "/api/access/organizations")
      return { organizations: [{ id: "org-a", name: "Org A" }] };
    if (String(path).includes("invitations")) return { invitations: [] };
    return {};
  });
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
});
describe("authenticated app access integration", () => {
  it("installs authentication and accepts access before graph data mounts, without a test-enrollment gate", async () => {
    // Exercise direct graph access; first-run /app opens the optional guide.
    window.history.replaceState({}, "", "/app?view=graph");
    let finish!: (value: unknown) => void;
    h.fetch.mockImplementationOnce(() => {
      expect(h.tokenReady).toBe(true);
      return new Promise<unknown>((resolve) => {
        finish = resolve;
      });
    });
    render(<App />);
    await screen.findByText("Opening Jack...");
    expect(h.graph).not.toHaveBeenCalled();
    await act(async () =>
      finish({ allowed: true, canInvite: false, organizations: [] }),
    );
    await screen.findByText("Member Living Memory");
    expect(h.fetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/access/accept",
    ]);
    expect(screen.queryByTestId("user-testing-restricted-gate")).toBeNull();
    expect(screen.queryByTestId("invite-users")).toBeNull();
  });
  it("links authorized invite management from the app and mounts its real route", async () => {
    h.canInvite = true;
    render(<App />);
    fireEvent.click(await screen.findByTestId("invite-users"));
    await screen.findByRole("heading", { name: "Invite people to Jack" });
    expect(window.location.pathname).toBe("/admin/access");
  });
});
