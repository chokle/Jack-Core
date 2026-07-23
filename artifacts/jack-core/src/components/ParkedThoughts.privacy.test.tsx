// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ParkedThought } from "@workspace/api-client-react";
import { ParkedThoughtsList } from "./ParkedThoughts";

const state = vi.hoisted(() => ({
  items: [] as ParkedThought[],
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    getListParkedThoughtsQueryKey: () => ["/api/parking-lot"],
    useListParkedThoughts: () => ({
      data: { items: state.items },
      isLoading: false,
      isError: false,
    }),
    useResumeParkedThought: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
    useArchiveParkedThought: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
  };
});

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

function thought(canManage: boolean): ParkedThought {
  return {
    id: "thought-1",
    source: "interview",
    interviewSessionId: "session-1",
    mentorProfileId: "mentor-1",
    mentorName: "Tracy",
    trade: "Electrician",
    category: null,
    topic: null,
    title: "meter testing",
    summary: "Private interview bookmark",
    unfinishedThought: null,
    reason: null,
    context: [],
    status: "parked",
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: null,
    canManage,
  };
}

function renderList() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ParkedThoughtsList
        onResumeChat={() => {}}
        onResumeInterview={() => {}}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.items = [];
});

afterEach(() => {
  cleanup();
});

describe("ParkedThoughtsList ownership controls", () => {
  it("never renders Resume or Archive without explicit manage permission", () => {
    state.items = [thought(false)];

    renderList();

    expect(screen.getByText("meter testing")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
  });

  it("preserves Resume and Archive for an owner-authorized thought", () => {
    state.items = [thought(true)];

    renderList();

    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Archive" })).toBeTruthy();
  });
});
