// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const identity = vi.hoisted(() => ({ isAdmin: false }));
vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({ data: { isAdmin: identity.isAdmin }, isLoading: false }),
  useListKnowledgeCandidates: () => ({
    data: { candidates: [] },
    isLoading: false,
    isError: false,
  }),
  useGetGraph: () => ({ data: { nodes: [] } }),
  useGetMentorContributions: () => ({ data: { contributions: [] } }),
  useResolveKnowledgeCandidate: () => ({ isPending: false, mutate: vi.fn() }),
  getListKnowledgeCandidatesQueryKey: () => ["candidates"],
  getGetGraphQueryKey: () => ["graph"],
  getGetMentorContributionsQueryKey: () => ["contributions"],
}));
vi.mock("./PendingKnowledgePanel", () => ({
  PendingKnowledgePanel: () => <div data-testid="public-review-queue" />,
}));
vi.mock("./MentorContributions", () => ({ MentorContributions: () => null }));
vi.mock("./MentorWithdrawal", () => ({ MentorWithdrawal: () => null }));
vi.mock("./GraphHealth", () => ({ GraphHealth: () => null }));
vi.mock("./UserTestFeedbackReview", () => ({
  UserTestFeedbackReview: () => <div data-testid="admin-feedback-review" />,
}));
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

describe("Knowledge Review feedback authorization", () => {
  afterEach(cleanup);

  it("does not render user-test feedback for non-admins", () => {
    identity.isAdmin = false;
    renderReview();
    expect(screen.queryByTestId("admin-feedback-review")).toBeNull();
    expect(screen.getByTestId("public-review-queue")).toBeTruthy();
  });

  it("renders user-test feedback for admins", () => {
    identity.isAdmin = true;
    renderReview();
    expect(screen.getByTestId("admin-feedback-review")).toBeTruthy();
  });
});
