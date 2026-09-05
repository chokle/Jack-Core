// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FloatingJack } from "./FloatingJack";

const api = vi.hoisted(() => ({
  askJack: vi.fn(),
  getMe: vi.fn(),
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/api-client-react")>()),
  askJack: api.askJack,
  getMe: api.getMe,
}));

class FakeSpeechRecognition {
  static latest: FakeSpeechRecognition | null = null;

  continuous = false;
  interimResults = false;
  lang = "en-CA";
  start = vi.fn();
  stop = vi.fn();
  abort = vi.fn();
  onresult: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onend: (() => void) | null = null;

  constructor() {
    FakeSpeechRecognition.latest = this;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  api.askJack.mockReset();
  api.getMe.mockReset();
  api.getMe.mockResolvedValue({});
  api.askJack.mockImplementation(() => new Promise(() => {}));
  FakeSpeechRecognition.latest = null;
  window.history.replaceState({}, "", "/app");
  document.title = "Jack";
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementation(
        async () => new Response("Unavailable", { status: 503 }),
      ),
  );
  Object.defineProperty(window, "SpeechRecognition", {
    configurable: true,
    writable: true,
    value: FakeSpeechRecognition,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("FloatingJack submission lifecycle", () => {
  it("refreshes revealed navigation controls without cancelling the current answer", async () => {
    let resolve!: (value: { answer: string }) => void;
    api.askJack.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    render(
      <>
        <section
          data-jack-surface="Video"
          data-jack-path='["Library","Root Pass Demo"]'
          data-video-id="v1"
        >
          <button data-jack-action="back" style={{ opacity: 0 }}>
            Back
          </button>
        </section>
        <FloatingJack />
      </>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Ask Jack" }), {
      target: { value: "Where am I?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send to Jack" }));
    const signal = api.askJack.mock.calls[0][1].signal;
    await act(async () => {
      screen.getByRole("button", { name: "Back" }).style.opacity = "1";
    });
    expect(signal.aborted).toBe(false);
    await act(async () => {
      resolve({ answer: "Root Pass Demo" });
    });
    expect(screen.getByText("Root Pass Demo")).toBeTruthy();
    expect(screen.getAllByText("Back")).toHaveLength(2);
    fireEvent.change(screen.getByRole("textbox", { name: "Ask Jack" }), {
      target: { value: "Explain this page" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send to Jack" }));
    const nextContext = JSON.parse(
      decodeURIComponent(
        api.askJack.mock.calls[1][1].headers["X-Jack-Context"],
      ),
    );
    expect(nextContext.navigation.canBack).toBe(true);
    await act(async () => {
      resolve({ answer: "Root Pass Demo" });
    });
    await act(async () => {
      screen.getByRole("button", { name: "Back" }).style.opacity = "0";
    });
    expect(screen.getByText("Root Pass Demo")).toBeTruthy();
  });

  it.each(["What's this?", "What is this?", "Where am I?"])(
    "sends %s to the backend with the current selection",
    async (message) => {
      render(
        <>
          <section
            data-jack-surface="Living Memory"
            data-jack-path={JSON.stringify(["Welder", "Root Pass"])}
            data-node-id="concept:root-pass"
          />
          <FloatingJack />
        </>,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      fireEvent.change(screen.getByLabelText("Ask Jack"), {
        target: { value: message },
      });
      fireEvent.click(screen.getByLabelText("Send to Jack"));

      expect(api.askJack).toHaveBeenCalledOnce();
      expect(api.askJack.mock.calls[0][0]).toEqual({ message });
      const context = JSON.parse(
        decodeURIComponent(
          api.askJack.mock.calls[0][1].headers["X-Jack-Context"],
        ),
      );
      expect(context.path).toEqual(["Welder", "Root Pass"]);
      expect(context.visibleIds).toContain("concept:root-pass");
    },
  );

  it.each([
    "Show me the source",
    "Show me the source for that.",
    "Show the source for this!",
  ])("executes the application source action for %s", async (message) => {
    const openSource = vi.fn();
    render(
      <>
        <button data-jack-action="source" onClick={openSource}>
          View original
        </button>
        <FloatingJack />
      </>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    fireEvent.change(screen.getByLabelText("Ask Jack"), {
      target: { value: message },
    });
    fireEvent.click(screen.getByLabelText("Send to Jack"));

    expect(openSource).toHaveBeenCalledOnce();
    expect(api.askJack).not.toHaveBeenCalled();
  });

  it.each(["animationend", "transitionend"])(
    "refreshes inspector awareness on %s without a DOM mutation",
    async (eventName) => {
      let revealed = false;
      const actualComputedStyle = window.getComputedStyle.bind(window);
      vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
        const style = actualComputedStyle(element);
        if (element.id === "animated-inspector") {
          Object.defineProperty(style, "opacity", {
            configurable: true,
            value: revealed ? "1" : "0",
          });
        }
        return style;
      });
      render(
        <>
          <section
            id="animated-inspector"
            data-jack-inspector
            data-jack-label="Selected capture"
          >
            <button data-jack-action="source">View original</button>
          </section>
          <FloatingJack />
        </>,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(screen.getByText("Closed")).toBeTruthy();
      expect(screen.queryByText("Source")).toBeNull();

      // CSS can change computed opacity without mutating an attribute.
      revealed = true;
      fireEvent(
        document.getElementById("animated-inspector")!,
        new Event(eventName, { bubbles: true }),
      );

      expect(screen.getByText("Selected capture")).toBeTruthy();
      expect(screen.getByText("Source")).toBeTruthy();
      expect(screen.queryByText("Closed")).toBeNull();
    },
  );

  it("shows recovery and ignores late speech when the page changes while listening", async () => {
    render(<FloatingJack />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    fireEvent.click(screen.getByLabelText("Talk to Jack"));
    const recognition = FakeSpeechRecognition.latest!;
    await act(async () => {
      window.history.pushState({}, "", "/library");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(recognition.abort).toHaveBeenCalledOnce();
    expect(
      screen.getByText("Page changed. Tap the mic to continue here."),
    ).toBeTruthy();
    act(() =>
      recognition.onresult?.({
        results: [{ 0: { transcript: "old page question" }, isFinal: true }],
      }),
    );
    expect(api.askJack).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Talk to Jack"));
    const restarted = FakeSpeechRecognition.latest!;
    expect(restarted).not.toBe(recognition);
    expect(restarted.start).toHaveBeenCalledOnce();
    act(() =>
      restarted.onresult?.({
        results: [{ 0: { transcript: "new page question" }, isFinal: true }],
      }),
    );
    expect(api.askJack).toHaveBeenCalledOnce();
    expect(
      JSON.parse(
        decodeURIComponent(
          api.askJack.mock.calls[0][1].headers["X-Jack-Context"],
        ),
      ).route,
    ).toBe("/library");
  });

  it("does not start a second request when final speech arrives during a typed submission", async () => {
    render(<FloatingJack />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    fireEvent.click(screen.getByLabelText("Talk to Jack"));
    const recognition = FakeSpeechRecognition.latest;
    expect(recognition).not.toBeNull();

    fireEvent.change(screen.getByLabelText("Ask Jack"), {
      target: { value: "typed question" },
    });
    fireEvent.click(screen.getByLabelText("Send to Jack"));
    expect(api.askJack).toHaveBeenCalledTimes(1);

    act(() => {
      recognition?.onresult?.({
        results: [{ 0: { transcript: "voice question" }, isFinal: true }],
      });
    });

    expect(api.askJack).toHaveBeenCalledTimes(1);
  });

  it("ignores late speech after a typed request has already completed", async () => {
    api.askJack.mockResolvedValue({ answer: "The typed answer" });
    render(<FloatingJack />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    fireEvent.click(screen.getByLabelText("Talk to Jack"));
    const recognition = FakeSpeechRecognition.latest!;
    fireEvent.change(screen.getByLabelText("Ask Jack"), {
      target: { value: "typed question" },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Send to Jack"));
    });
    expect(screen.getByText("The typed answer")).toBeTruthy();
    expect(recognition.abort).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByLabelText("Ask Jack"), {
      target: { value: "next draft" },
    });
    act(() => {
      recognition.onresult?.({
        results: [{ 0: { transcript: "late voice question" }, isFinal: true }],
      });
    });

    expect(api.askJack).toHaveBeenCalledOnce();
    expect((screen.getByLabelText("Ask Jack") as HTMLInputElement).value).toBe(
      "next draft",
    );
  });
});
