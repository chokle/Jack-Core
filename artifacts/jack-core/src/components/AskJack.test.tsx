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

type AskJackResponse = {
  answer: string;
  citations: unknown[];
  usedInternalKnowledge: boolean;
};

type PendingCall = {
  message: string;
  onSuccess?: (response: AskJackResponse) => void;
  onError?: (error: unknown) => void;
};

const askJackState = vi.hoisted(() => ({
  isPending: false,
  mutate: vi.fn(),
  pendingCalls: [] as PendingCall[],
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

function resolveSuccess(response: AskJackResponse, index = 0): void {
  const call = askJackState.pendingCalls[index];
  if (!call) return;
  call.onSuccess?.(response);
  askJackState.pendingCalls.splice(index, 1);
  askJackState.isPending = askJackState.pendingCalls.length > 0;
}

function resolveError(index = 0, status = 500): void {
  const call = askJackState.pendingCalls[index];
  if (!call) return;
  call.onError?.({ response: { status } });
  askJackState.pendingCalls.splice(index, 1);
  askJackState.isPending = askJackState.pendingCalls.length > 0;
}

function configureAskJackSuccess() {
  askJackState.pendingCalls = [];
  askJackState.isPending = false;
  askJackState.mutate.mockImplementation(
    (
      _payload: { data: { message: string } },
      options?: { onSuccess: (response: AskJackResponse) => void },
    ) => {
      options?.onSuccess({
        answer: `Alright. Let’s sort it out. (${_payload.data.message})`,
        citations: [],
        usedInternalKnowledge: true,
      });
    },
  );
}

function configureAskJackError(errorStatus: number) {
  askJackState.pendingCalls = [];
  askJackState.isPending = false;
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
  askJackState.pendingCalls = [];
  askJackState.mutate.mockImplementation(
    (
      payload: { data: { message: string } },
      options?: {
        onSuccess?: (response: AskJackResponse) => void;
        onError?: (error: { status: number }) => void;
      },
    ) => {
      askJackState.isPending = true;
      askJackState.pendingCalls.push({
        message: payload.data.message,
        onSuccess: options?.onSuccess,
        onError: options?.onError,
      });
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
    askJackState.pendingCalls = [];
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
      expect(screen.getByTestId("assistant-message").textContent).to.contain(
        "How's it going?",
      );
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
      expect(screen.getByTestId("assistant-message")).to.not.be.null;
      expect(screen.getByTestId("assistant-message").textContent).to.contain(
        "Teach me about welding",
      );
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
      const answers = screen.getAllByTestId("assistant-message");
      expect(answers.length).to.equal(1);
      expect(answers[0].textContent).to.contain("How's it going?");
    });
    expect(document.activeElement).to.equal(input);

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
      expect(input.disabled).to.be.false;
      expect(input.value).to.equal("");
    });

    fireEvent.change(input, {
      target: { value: "Second draft while waiting" },
    });
    expect(input.value).to.equal("Second draft while waiting");
    expect(sendButton.disabled).to.be.false;

    const form = input.closest("form");
    expect(form).toBeTruthy();
    fireEvent.submit(form as HTMLFormElement);
    expect(askJackState.mutate).toHaveBeenCalledTimes(1);

    resolveSuccess(
      {
        answer: "Alright. Let’s sort it out.",
        citations: [],
        usedInternalKnowledge: true,
      },
      0,
    );

    await waitFor(() => {
      expect(screen.getByTestId("assistant-message").textContent).to.contain(
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
      expect(input.disabled).to.be.false;
    });

    fireEvent.change(input, {
      target: { value: "Second draft after submit" },
    });
    expect(sendButton.disabled).to.be.false;

    resolveError(0, 500);

    await waitFor(() => {
      const error = screen.getByTestId("ask-jack-error");
      expect(error).to.not.be.null;
      expect(error.textContent).to.contain(
        "Ask Jack is temporarily unavailable. Please try again in a moment.",
      );
      expect(input.value).to.equal("Second draft after submit");
      expect(document.activeElement).to.equal(input);
    });
  });

  it("shows a local timestamp for user and assistant messages", async () => {
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

  it("shows the configured Ask Jack composer placeholder", () => {
    configureAskJackSuccess();
    renderAskJack();

    const input = screen.getByTestId("chat-input") as HTMLInputElement;
    expect(input.placeholder).to.equal("What\u2019s going on?");
  });

  it("opens steer choice while pending and offers WAIT", async () => {
    configureAskJackPending();
    renderAskJack();

    const input = screen.getByTestId("chat-input") as HTMLInputElement;
    const sendButton = screen.getByTestId("send-button") as HTMLButtonElement;

    fireEvent.change(input, { target: { value: "How do I fix this?" } });
    fireEvent.click(sendButton);

    fireEvent.change(input, { target: { value: "Need more detail." } });
    const form = input.closest("form");
    expect(form).toBeTruthy();
    expect(sendButton.disabled).to.be.false;
    fireEvent.submit(form as HTMLFormElement);

    const prompt = await screen.findByText(
      "Jack’s still thinking. What should happen?",
    );
    const waitButton = await screen.findByRole("button", { name: "Wait" });
    expect(prompt).to.not.be.null;
    expect(waitButton).to.not.be.null;
    expect(screen.queryByRole("button", { name: "Jump in" })).to.be.null;

    fireEvent.click(waitButton);

    await waitFor(() => {
      expect(input.value).to.equal("");
    });
  });

  it("supports Wait and sends queued message once after active request completes", async () => {
    configureAskJackPending();
    renderAskJack();

    const input = screen.getByTestId("chat-input") as HTMLInputElement;
    const sendButton = screen.getByTestId("send-button") as HTMLButtonElement;

    fireEvent.change(input, { target: { value: "A1" } });
    fireEvent.click(sendButton);

    fireEvent.change(input, { target: { value: "B2" } });
    const form = input.closest("form");
    expect(form).toBeTruthy();
    fireEvent.submit(form as HTMLFormElement);
    fireEvent.click(screen.getByRole("button", { name: "Wait" }));

    resolveSuccess(
      {
        answer: "response-A1",
        citations: [],
        usedInternalKnowledge: true,
      },
      0,
    );

    await waitFor(() => {
      expect(askJackState.pendingCalls.length).to.equal(1);
    });

    const callAfterWait = askJackState.pendingCalls[0]?.message;
    expect(callAfterWait).to.equal("B2");

    resolveSuccess(
      {
        answer: "response-B2",
        citations: [],
        usedInternalKnowledge: true,
      },
      0,
    );

    await waitFor(() => {
      const answers = screen.getAllByTestId("assistant-message");
      expect(answers.map((a) => a.textContent)).to.deep.equal([
        "response-A1",
        "response-B2",
      ]);
    });
  });

  it("preserves a queued message if the active request fails", async () => {
    configureAskJackPending();
    renderAskJack();

    const input = screen.getByTestId("chat-input") as HTMLInputElement;
    const sendButton = screen.getByTestId("send-button") as HTMLButtonElement;

    fireEvent.change(input, { target: { value: "A1" } });
    fireEvent.click(sendButton);

    fireEvent.change(input, { target: { value: "B2" } });
    const form = input.closest("form");
    expect(form).toBeTruthy();
    fireEvent.submit(form as HTMLFormElement);
    fireEvent.click(screen.getByRole("button", { name: "Wait" }));

    resolveError(0, 500);

    await waitFor(() => {
      expect(screen.queryByTestId("ask-jack-error")).to.not.be.null;
      expect(input.value).to.equal("B2");
      expect(screen.queryByRole("button", { name: "Wait" })).to.be.null;
      expect(screen.queryByRole("button", { name: "Jump in" })).to.be.null;
    });
  });

  it("dismisses steer choice and keeps draft intact", async () => {
    configureAskJackPending();
    renderAskJack();

    const input = screen.getByTestId("chat-input") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "A1" } });
    fireEvent.click(screen.getByTestId("send-button"));

    fireEvent.change(input, { target: { value: "What now?" } });
    const form = input.closest("form");
    expect(form).toBeTruthy();
    fireEvent.submit(form as HTMLFormElement);

    expect(
      await screen.findByText("Jack’s still thinking. What should happen?"),
    ).to.not.be.null;
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Jack’s still thinking. What should happen?")).to
      .be.null;
    expect(input.value).to.equal("What now?");
  });
});
