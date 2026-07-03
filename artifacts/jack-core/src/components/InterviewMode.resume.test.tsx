// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  InterviewSession,
  InterviewAnswer,
  InterviewSessionDetail,
} from "@workspace/api-client-react";

/**
 * Browser-level regression coverage for the interrupted-interview resume flow in
 * InterviewMode: on mount it reads the stored session id from localStorage,
 * rehydrates the transcript + current question, clears the stored id when the
 * interview wraps up, and falls back to the intake form (without erroring) when
 * the stored id is stale/nonexistent (a 404 from the session fetch).
 */

const ACTIVE_SESSION_KEY = "jack.interview.activeSessionId";
const DRAFT_KEY_PREFIX = "jack.interview.draft.";

// Controllable mocks, hoisted so the vi.mock factories below can close over them.
const h = vi.hoisted(() => ({
  getInterviewSession: vi.fn(),
  startMutate: vi.fn(),
  submitMutate: vi.fn(),
  skipMutate: vi.fn(),
  finishMutate: vi.fn(),
}));

vi.mock("@workspace/api-client-react", () => ({
  useStartInterview: () => ({ mutate: h.startMutate, isPending: false }),
  useSubmitInterviewAnswer: () => ({ mutate: h.submitMutate, isPending: false }),
  useSkipInterviewQuestion: () => ({ mutate: h.skipMutate, isPending: false }),
  useFinishInterview: () => ({ mutate: h.finishMutate, isPending: false }),
  getInterviewSession: h.getInterviewSession,
  getGetGraphQueryKey: () => ["graph"],
}));

// Park-a-thought UI pulls in additional API deps that are irrelevant here, and
// consumeInterviewResumeNote must default to "no note" so no banner is shown.
vi.mock("@/components/ParkedThoughts", () => ({
  ParkThisThoughtButton: () => null,
  consumeInterviewResumeNote: () => null,
}));

// Radix ScrollArea needs ResizeObserver; keep the real component but polyfill it.
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { InterviewMode } from "./InterviewMode";

const CURRENT_QUESTION = "What's your go-to safety check before striking an arc?";

function makeSession(overrides: Partial<InterviewSession> = {}): InterviewSession {
  return {
    id: "sess-1",
    mentorProfileId: "mentor-1",
    mentorName: "Test Mentor",
    trade: "Welder",
    status: "active",
    currentQuestion: CURRENT_QUESTION,
    currentCategory: "Safety",
    currentTopic: "PPE",
    questionCount: 3,
    complete: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeAnswer(overrides: Partial<InterviewAnswer> = {}): InterviewAnswer {
  return {
    id: "ans-1",
    question: "Question one?",
    category: "Safety",
    topic: "PPE",
    answerText: "Answer one text.",
    skipped: false,
    distillationStatus: "verified",
    extractedKnowledge: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function renderInterviewMode() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <InterviewMode />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("InterviewMode resume flow", () => {
  it("rehydrates an interrupted interview from a stored session id: transcript restored, current question ready", async () => {
    localStorage.setItem(ACTIVE_SESSION_KEY, "sess-1");
    const detail: InterviewSessionDetail = {
      session: makeSession(),
      answers: [
        makeAnswer({ id: "ans-1", answerText: "We lock out and verify zero voltage first." }),
        makeAnswer({ id: "ans-2", answerText: "Inspect the ground clamp before every arc." }),
      ],
    };
    h.getInterviewSession.mockResolvedValue(detail);

    renderInterviewMode();

    // Lands back in the conversation on the current question, not the intake form.
    expect(await screen.findByText(CURRENT_QUESTION)).toBeTruthy();
    expect(screen.queryByText("Tell Jack who's in the chair")).toBeNull();

    // Prior transcript is restored.
    expect(screen.getByText("We lock out and verify zero voltage first.")).toBeTruthy();
    expect(screen.getByText("Inspect the ground clamp before every arc.")).toBeTruthy();

    // The answer box is ready for the next answer.
    expect(
      screen.getByPlaceholderText(/Answer in your own words/i),
    ).toBeTruthy();

    // Fetched using the stored id.
    expect(h.getInterviewSession).toHaveBeenCalledWith("sess-1");
  });

  it("does NOT apply a saved draft typed against a different (stale) question on resume", async () => {
    localStorage.setItem(ACTIVE_SESSION_KEY, "sess-1");
    // A draft was typed against question A, but the session has since advanced to
    // the current question B — the stale draft must never land on question B.
    localStorage.setItem(
      `${DRAFT_KEY_PREFIX}sess-1`,
      JSON.stringify({
        question: "An older question the mentor already answered?",
        text: "Half-typed answer to the OLD question.",
      }),
    );
    h.getInterviewSession.mockResolvedValue({
      session: makeSession(),
      answers: [makeAnswer()],
    } satisfies InterviewSessionDetail);

    renderInterviewMode();

    // Back on the current question B, not the intake form.
    expect(await screen.findByText(CURRENT_QUESTION)).toBeTruthy();

    // The answer box is empty — the stale draft was rejected.
    const box = screen.getByPlaceholderText(/Answer in your own words/i) as HTMLTextAreaElement;
    expect(box.value).toBe("");
  });

  it("restores a saved draft typed against the current question on resume", async () => {
    localStorage.setItem(ACTIVE_SESSION_KEY, "sess-1");
    const draftText = "Half-typed answer to the CURRENT question.";
    localStorage.setItem(
      `${DRAFT_KEY_PREFIX}sess-1`,
      JSON.stringify({ question: CURRENT_QUESTION, text: draftText }),
    );
    h.getInterviewSession.mockResolvedValue({
      session: makeSession(),
      answers: [makeAnswer()],
    } satisfies InterviewSessionDetail);

    renderInterviewMode();

    expect(await screen.findByText(CURRENT_QUESTION)).toBeTruthy();

    // The matching draft is restored into the answer box.
    const box = screen.getByPlaceholderText(/Answer in your own words/i) as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toBe(draftText));
  });

  it("clears the stored session when the interview is wrapped up", async () => {
    localStorage.setItem(ACTIVE_SESSION_KEY, "sess-1");
    h.getInterviewSession.mockResolvedValue({
      session: makeSession(),
      answers: [makeAnswer()],
    } satisfies InterviewSessionDetail);

    // Wrapping up resolves with a completed session.
    h.finishMutate.mockImplementation(
      (_vars: unknown, opts: { onSuccess: (s: InterviewSession) => void }) => {
        opts.onSuccess(makeSession({ complete: true, currentQuestion: null }));
      },
    );

    renderInterviewMode();
    await screen.findByText(CURRENT_QUESTION);
    expect(localStorage.getItem(ACTIVE_SESSION_KEY)).toBe("sess-1");

    fireEvent.click(screen.getByRole("button", { name: /Wrap up/i }));

    // Completion card shown and the stored session cleared, so a later visit
    // starts fresh at the intake form.
    expect(await screen.findByText(/Thanks, Test Mentor/i)).toBeTruthy();
    expect(localStorage.getItem(ACTIVE_SESSION_KEY)).toBeNull();
  });

  it("falls back to the intake form when the stored session id is stale (404)", async () => {
    localStorage.setItem(ACTIVE_SESSION_KEY, "does-not-exist");
    h.getInterviewSession.mockRejectedValue({ status: 404 });

    renderInterviewMode();

    // No crash — the intake form is shown and the stale id is dropped.
    expect(await screen.findByText("Tell Jack who's in the chair")).toBeTruthy();
    await waitFor(() =>
      expect(localStorage.getItem(ACTIVE_SESSION_KEY)).toBeNull(),
    );
  });

  it("shows the intake form immediately when there is no stored session", async () => {
    renderInterviewMode();

    expect(await screen.findByText("Tell Jack who's in the chair")).toBeTruthy();
    expect(h.getInterviewSession).not.toHaveBeenCalled();
  });
});
