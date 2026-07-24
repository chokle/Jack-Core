// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { AuthenticatedAppSurface } from "./App";

const mockSignOut = vi.fn();
const mockUseClerk = vi.fn();
const mockUseGetMe = vi.fn();
const mockUseMemoryGraphData = vi.fn();

vi.mock("@clerk/react", () => ({
  useClerk: () => mockUseClerk(),
  useAuth: () => ({ isLoaded: true, isSignedIn: true }),
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => mockUseGetMe(),
  setAuthTokenGetter: vi.fn(),
}));

vi.mock("./lib/use-memory-graph", () => ({
  useMemoryGraphData: () => mockUseMemoryGraphData(),
}));

vi.mock("./components/JackShell", () => ({
  JackShell: ({ onOpenSettings, onSignOut, children }: any) => (
    <div>
      {onOpenSettings && (
        <button type="button" onClick={onOpenSettings} data-testid="account-settings">
          Account Settings
        </button>
      )}
      {onSignOut && (
        <button type="button" onClick={onSignOut} data-testid="sign-out">
          Logout
        </button>
      )}
      {children}
    </div>
  ),
}));

vi.mock("./components/KnowledgeGraph", () => ({
  KnowledgeGraph: () => null,
}));

vi.mock("./components/KnowledgeReview", () => ({
  KnowledgeReview: () => null,
}));

vi.mock("./components/MemoryGraphView", () => ({
  MemoryGraphView: () => null,
}));

vi.mock("./components/InterviewMode", () => ({
  InterviewMode: () => null,
}));

vi.mock("./components/Library", () => ({
  Library: () => null,
}));

vi.mock("./components/VideoDetail", () => ({
  VideoDetail: () => null,
}));

vi.mock("./components/AskJack", () => ({
  AskJack: () => null,
}));

vi.mock("./components/testing/TestingOverlay", () => ({
  TestingOverlay: () => null,
}));

vi.mock("./components/testing/UserTestFeedback", () => ({
  UserTestFeedback: () => null,
}));

vi.mock("./components/SystemHealthWidget", () => ({
  SystemHealthWidget: () => null,
}));

vi.mock("@/components/ui/toaster", () => ({
  Toaster: () => null,
}));

const graphData = {
  isLoading: false,
  model: {
    counts: { nodes: 1, connections: 2, knowledge: 3, topics: 4 },
  },
  readyCount: 0,
};

describe("AuthenticatedAppSurface auth-gated account controls", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows account settings and Logout for authenticated users", () => {
    mockUseClerk.mockReturnValue({
      signOut: mockSignOut,
    });
    mockUseGetMe.mockReturnValue({
      data: {
        userId: "user_123",
        name: "Alex",
        isAdmin: false,
      },
    });
    mockUseMemoryGraphData.mockReturnValue(graphData as never);

    render(<AuthenticatedAppSurface />);

    expect(screen.getByTestId("account-settings")).toBeTruthy();
    expect(screen.getByTestId("sign-out")).toBeTruthy();

    fireEvent.click(screen.getByTestId("sign-out"));
    expect(mockSignOut).toHaveBeenCalledOnce();
    expect(mockSignOut).toHaveBeenCalledWith({ redirectUrl: "/sign-in" });
  });

  it("hides account settings and Logout in presentation-demo mode", () => {
    mockUseClerk.mockReturnValue({
      signOut: mockSignOut,
    });
    mockUseGetMe.mockReturnValue({
      data: {
        userId: "presentation-demo",
        name: "Presentation Demo",
        isAdmin: false,
      },
    });
    mockUseMemoryGraphData.mockReturnValue(graphData as never);

    render(<AuthenticatedAppSurface />);

    expect(screen.queryByTestId("account-settings")).toBeNull();
    expect(screen.queryByTestId("sign-out")).toBeNull();
  });
});
