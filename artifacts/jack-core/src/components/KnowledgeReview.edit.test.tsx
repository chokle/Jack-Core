// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mutate = vi.hoisted(() => vi.fn());
vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({ data: { isAdmin: true }, isLoading: false }),
  useListKnowledgeCandidates: () => ({
    data: {
      candidates: [
        {
          id: "candidate-1",
          status: "pending",
          title: "Gas cover clean",
          description: "Original wording",
          category: "concept",
          trade: "Welder",
          confidence: 0.8,
          competencyCode: null,
          mentorProfileId: "mentor-1",
          mentorName: "Dana",
          answerId: "answer-1",
          sessionId: "session-1",
          question: "How do you protect the weld?",
          answerText: "Keep the cup close and block the wind.",
          sourceValid: true,
          bestMatches: [],
          createdAt: null,
          resolvedTargetId: null,
          resolutionReason: null,
          resolvedAt: null,
          requestedTargetId: null,
          redirectReason: null,
        },
      ],
    },
    isLoading: false,
    isError: false,
  }),
  useGetGraph: () => ({ data: { nodes: [] } }),
  useGetMentorContributions: () => ({ data: { contributions: [] } }),
  useResolveKnowledgeCandidate: () => ({ isPending: false, mutate }),
  getListKnowledgeCandidatesQueryKey: () => ["candidates"],
  getGetGraphQueryKey: () => ["graph"],
  getGetMentorContributionsQueryKey: () => ["contributions"],
}));
vi.mock("./PendingKnowledgePanel", () => ({
  PendingKnowledgePanel: () => null,
}));
vi.mock("./MentorContributions", () => ({ MentorContributions: () => null }));
vi.mock("./MentorWithdrawal", () => ({ MentorWithdrawal: () => null }));
vi.mock("./GraphHealth", () => ({ GraphHealth: () => null }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { KnowledgeReview } from "./KnowledgeReview";

function renderReview() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <KnowledgeReview />
    </QueryClientProvider>,
  );
}

describe("Knowledge Review candidate editing", () => {
  afterEach(() => {
    cleanup();
    mutate.mockReset();
  });

  it("submits reviewer-corrected content through the edit resolution action", () => {
    renderReview();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Edited concept title"), {
      target: { value: "Protecting shielding gas" },
    });
    fireEvent.change(screen.getByLabelText("Edited concept description"), {
      target: {
        value: "Keep the nozzle close and protect the arc from drafts.",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save & accept" }));

    expect(mutate).toHaveBeenCalledWith({
      id: "candidate-1",
      data: {
        action: "edit",
        editedTitle: "Protecting shielding gas",
        editedDescription:
          "Keep the nozzle close and protect the arc from drafts.",
      },
    });
  });
});
