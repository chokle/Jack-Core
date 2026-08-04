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
  pendingOnSuccess: undefined as
    | ((response: AskJackResponse) => void)
    | undefined,
  pendingOnError: undefined as ((error: unknown) => void) | undefined,
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

function configureAskJackPending() {
  askJackState.next = "success";
  askJackState.pendingOnSuccess = undefined;
  askJackState.pendingOnError = undefined;
  askJackState.mutate.mockImplementation(
    (
      _payload: { data: { message: string } },
      options?: {
        onSuccess?: (response: AskJackResponse) => void;
        onError?: (error: { status: number }) => void;
      },
    ) => {
      askJackState.isPending = true;
      askJackState.pendingOnSuccess = options?.onSuccess;
      askJackState.pendingOnError = options?.onError;
    },
  );
}

function resolveAskJackPendingSuccess(response: AskJackResponse) {
  askJackState.isPending = false;
  askJackState.pendingOnSuccess?.(response);
  askJackState.pendingOnSuccess = undefined;
}

function resolveAskJackPendingError(error: number) {
  askJackState.isPending = false;
  askJackState.pendingOnError?.({
    response: { status: error },
  });
  askJackState.pendingOnError = undefined;
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
    askJackState.pendingOnSuccess = undefined;
    askJackState.pendingOnError = undefined;
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

  it("restores focus for repeated sends without requiring a click", async () => {
    configureAskJackSuccess();
    renderAskJack();

    const input = screen.getByTestId("chat-input") as HTMLInputElement;
    const sendButton = screen.getByTestId("send-button") as HTMLButtonElement;

    input.focus();
    fireEvent.change(input, { target: { value: "How's it going?" } });
    fireEvent.click(sendButton);

    await waitFor(() => {
      const answer = screen.getByTestId("assistant-message");
      expect(answer).to.not.be.null;
      expect(answer.textContent).to.equal("Alright. Let’s sort it out.");
      expect(document.activeElement).to.equal(input);
    });

    fireEvent.change(input, { target: { value: "Need another help" } });
    fireEvent.click(sendButton);

    await waitFor(() => {
      const answers = screen.getAllByTestId("assistant-message");
      expect(answers.length).to.equal(2);
      expect(document.activeElement).to.equal(input);
    });
  });

  it("keeps composer editable during pending and preserves draft text", async () => {
    configureAskJackPending();
    renderAskJack();

    const input = screen.getByTestId("chat-input") as HTMLInputElement;
    const sendButton = screen.getByTestId("send-button") as HTMLButtonElement;

    input.focus();
    fireEvent.change(input, { target: { value: "Could you help with that?" } });
    fireEvent.click(sendButton);

    await waitFor(() => {
      expect(sendButton.disabled).to.be.true;
      expect(input.disabled).to.be.false;
      expect(input.value).to.equal("");
      expect(screen.getByText("Lemme think for a sec...")).to.not.be.null;
    });

    fireEvent.change(input, {
      target: { value: "Second draft while waiting" },
    });
    expect(input.value).to.equal("Second draft while waiting");

    fireEvent.click(sendButton);
    expect(askJackState.mutate).toHaveBeenCalledTimes(1);

    resolveAskJackPendingSuccess({
      answer: "Alright. Let’s sort it out.",
      citations: [],
      usedInternalKnowledge: true,
    });

    await waitFor(() => {
      expect(screen.getByTestId("assistant-message").textContent).to.equal(
        "Alright. Let’s sort it out.",
      );
      expect(input.value).to.equal("Second draft while waiting");
      expect(document.activeElement).to.equal(input);
    });
  });

  it("preserves a second draft if a request fails while pending", async () => {
    configureAskJackPending();
    renderAskJack();

    const input = screen.getByTestId("chat-input") as HTMLInputElement;
    const sendButton = screen.getByTestId("send-button") as HTMLButtonElement;

    fireEvent.change(input, { target: { value: "What causes this defect?" } });
    fireEvent.click(sendButton);

    await waitFor(() => {
      expect(sendButton.disabled).to.be.true;
      expect(input.disabled).to.be.false;
    });

    fireEvent.change(input, {
      target: { value: "Second draft after submit" },
    });

    resolveAskJackPendingError(500);

    await waitFor(() => {
      const error = screen.getByTestId("ask-jack-error");
      expect(error).to.not.be.null;
      expect(input.value).to.equal("Second draft after submit");
      expect(document.activeElement).to.equal(input);
    });
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

  it("shows conversational loading copy while waiting for an assistant response", () => {
    askJackState.isPending = true;
    renderAskJack();

    expect(screen.getByText("Lemme think for a sec...")).to.not.be.null;
    cleanup();

    askJackHistory.data = [
      {
        id: "history-user",
        role: "user",
        content: "Teach me about welding",
        createdAt: "2026-01-01T15:24:00.000Z",
      },
    ];
    renderAskJack();

    expect(screen.getByText("Lemme think for a sec...")).to.not.be.null;
  });
});
