// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useRef } from "react";
import { AskJack } from "./AskJack";

const askJackState = vi.hoisted(() => ({
  next: "success" as "success" | "error",
  status: 200,
  isPending: false,
  mutate: vi.fn(),
}));
const askJackHistory = vi.hoisted(() => ({
  data: [] as {
    id: string;
    role: "user" | "assistant";
    content: string;
    createdAt?: string;
    citations?: unknown[];
  }[],
}));

vi.mock("@workspace/api-client-react", () => ({
  useAskJack: () => ({
    isPending: askJackState.isPending,
    mutate: askJackState.mutate,
  }),
  useGetChatHistory: () => ({ data: askJackHistory.data }),
  useClearChatHistory: () => ({ mutate: vi.fn(), isPending: false }),
  getGetChatHistoryQueryKey: () => ["chat-history"],
}));

vi.mock("@/components/StructuredAnswer", () => ({
  StructuredAnswer: ({ content }: { content: string }) => (
    <div data-testid="assistant-message">{content}</div>
  ),
}));

vi.mock("@/components/ParkedThoughts", () => ({
  ParkThisThoughtButton: () => <button>Park</button>,
}));

vi.mock("@/lib/user-testing/test-session-service", () => ({
  getCachedTestSession: () => null,
}));

type AskJackResponse = {
  answer: string;
  citations: unknown[];
  usedInternalKnowledge: boolean;
};

function configureAskJackSuccess() {
  askJackState.next = "success";
  askJackState.mutate.mockImplementation(
    (
      _payload: { data: { message: string } },
      options?: { onSuccess: (response: AskJackResponse) => void },
    ) => {
      options?.onSuccess({
        answer: "Alright. Let’s sort it out.",
        citations: [],
        usedInternalKnowledge: true,
      });
    },
  );
}

function configureAskJackError(errorStatus: number) {
  askJackState.next = "error";
  askJackState.mutate.mockImplementation(
    (
      _payload: { data: { message: string } },
      options?: { onError: (error: { status: number }) => void },
    ) => {
      options?.onError({ status: errorStatus });
    },
  );
}

function renderAskJack() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const close = vi.fn();
  const Harness = () => {
    const closeRef = useRef(close);
    return (
      <div>
        <button type="button">Outside</button>
        <AskJack
          isOpen
          onClose={() => closeRef.current()}
          onCitationClick={vi.fn()}
          onFieldNoteClick={vi.fn()}
        />
      </div>
    );
  };
  return render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
}

describe("AskJack UX", () => {
  beforeEach(() => {
    askJackState.isPending = false;
    configureAskJackSuccess();
    askJackHistory.data = [];
  });

  afterEach(() => {
    cleanup();
    askJackState.mutate.mockReset();
  });

  it("restores input focus after a successful send when input was focused", async () => {
    configureAskJackSuccess();
    renderAskJack();

    const input = screen.getByTestId("chat-input") as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: "How's it going?" } });
    fireEvent.click(screen.getByTestId("send-button"));

    await waitFor(() => {
      const answer = screen.getByTestId("assistant-message");
      expect(answer).to.not.be.null;
      expect(answer.textContent).to.equal("Alright. Let’s sort it out.");
    });

    expect(screen.queryByTestId("ask-jack-error")).toBeNull();
    expect(input.value).to.equal("");
    expect(document.activeElement).to.equal(input);
  });

  it("shows a visible error and keeps focus for 401/5xx failures", async () => {
    configureAskJackError(401);
    renderAskJack();

    const input = screen.getByTestId("chat-input") as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: "Fuck you Jack" } });
    fireEvent.click(screen.getByTestId("send-button"));

    await waitFor(() => {
      const error = screen.getByTestId("ask-jack-error");
      expect(error).to.not.be.null;
      expect(error.textContent).to.contain(
        "Your session is no longer active. Please sign in and try again.",
      );
    });
    expect(input.value).to.equal("Fuck you Jack");
    expect(document.activeElement).to.equal(input);
  });

  it("does not steal focus when user is intentionally focused elsewhere", async () => {
    configureAskJackSuccess();
    renderAskJack();

    const outside = screen.getByRole("button", { name: "Outside" });
    const input = screen.getByTestId("chat-input") as HTMLInputElement;
    outside.focus();
    fireEvent.change(input, { target: { value: "Teach me about welding" } });
    fireEvent.click(screen.getByTestId("send-button"));

    await waitFor(() => {
      const answer = screen.getByTestId("assistant-message");
      expect(answer).to.not.be.null;
      expect(answer.textContent).to.equal("Alright. Let’s sort it out.");
    });
    expect(document.activeElement).to.not.equal(input);
    expect(input.value).to.equal("");
  });

  it("renders a local timestamp for user and assistant messages", async () => {
    askJackHistory.data = [
      {
        id: "history-user",
        role: "user",
        content: "Hello Jack",
        createdAt: "2026-01-01T15:24:00.000Z",
      },
      {
        id: "history-assistant",
        role: "assistant",
        content: "Got you.",
        createdAt: "2026-01-01T15:24:30.000Z",
        citations: [],
      },
    ];
    configureAskJackSuccess();
    renderAskJack();

    const timestamps = await screen.findAllByText(
      /\b\d{1,2}:\d{2}(?:\s*[AP]M)?\b/,
    );
    expect(timestamps).to.have.length(2);
  });
});
