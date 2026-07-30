// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ParkedThought } from "@workspace/api-client-react";
import { ParkedThoughtsList } from "./ParkedThoughts";

const state = vi.hoisted(() => ({
  items: [] as ParkedThought[],
  resumeMutate: vi.fn(),
  resumeOptions: undefined as
    | { onSuccess?: (thought: ParkedThought) => void }
    | undefined,
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
    useResumeParkedThought: (options: {
      mutation?: { onSuccess?: (thought: ParkedThought) => void };
    }) => {
      state.resumeOptions = options.mutation;
      return { mutate: state.resumeMutate, isPending: false };
    },
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

function renderList(onResumeInterview = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ParkedThoughtsList
        onResumeChat={() => {}}
        onResumeInterview={onResumeInterview}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.items = [];
  state.resumeMutate.mockReset();
  state.resumeOptions = undefined;
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

  it("resumes through the endpoint and hands off its exact interview session id", () => {
    const owned = thought(true);
    state.items = [owned];
    const onResumeInterview = vi.fn();

    renderList(onResumeInterview);
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));

    expect(state.resumeMutate).toHaveBeenCalledWith({ id: owned.id });
    state.resumeOptions?.onSuccess?.({
      ...owned,
      status: "resumed",
      interviewSessionId: "server-session-exact",
    });
    expect(onResumeInterview).toHaveBeenCalledWith("server-session-exact");
  });
});
