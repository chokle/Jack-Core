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
  it("keeps Jack usable inside an account dialog and restores him after it closes", async () => {
    const view = render(<FloatingJack />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    const dialog = document.createElement("section");
    dialog.setAttribute("role", "alertdialog");
    dialog.dataset.jackSurface = "Account settings";
    dialog.dataset.jackPath = '["Account settings", "Account & privacy"]';
    dialog.innerHTML =
      "<h2>Account & privacy</h2><div data-jack-assistant-host></div>";
    await act(async () => {
      document.body.append(dialog);
    });
    const input = screen.getByRole("textbox");
    expect(dialog.contains(input)).toBe(true);
    expect(document.querySelectorAll("[data-floating-jack]")).toHaveLength(1);
    fireEvent.change(input, { target: { value: "Explain this screen" } });
    fireEvent.submit(input.closest("form")!);
    expect(api.askJack).toHaveBeenCalledOnce();
    await act(async () => {
      dialog.remove();
    });
    expect(view.container.querySelector("[data-floating-jack]")).not.toBeNull();
    expect(document.querySelectorAll("[data-floating-jack]")).toHaveLength(1);
  });

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

describe("operational voice boundary", () => {
  it("drops a queued listening start before submitting the actual question", async () => {
    api.getMe.mockResolvedValue({ userId: "voice-user", isAdmin: false });
    render(<FloatingJack />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Talk to Jack"));
      FakeSpeechRecognition.latest!.onresult?.({
        results: [{ 0: { transcript: "Explain this page" }, isFinal: true }],
      });
    });
    expect(api.askJack).toHaveBeenCalledOnce();
    const observations = vi
      .mocked(fetch)
      .mock.calls.filter(([url]) =>
        String(url).includes("/api/operational/voice"),
      )
      .map(([, options]) => JSON.parse(String(options?.body)).type);
    expect(observations).toEqual(["voice.listening.stopped"]);
  });

  it.each(["started", "stopped"])(
    "submits immediately while a listening %s observation is unresolved",
    async (unresolvedType) => {
      api.getMe.mockResolvedValue({ userId: "voice-user", isAdmin: false });
      vi.mocked(fetch).mockImplementation(async (_input, options) => {
        const type = JSON.parse(String(options?.body)).type;
        if (type === `voice.listening.${unresolvedType}`)
          return new Promise<Response>(() => {});
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      });
      render(<FloatingJack />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      await act(async () => {
        fireEvent.click(screen.getByLabelText("Talk to Jack"));
      });
      const submittedAt = Date.now();
      await act(async () => {
        FakeSpeechRecognition.latest!.onresult?.({
          results: [{ 0: { transcript: "Explain this page" }, isFinal: true }],
        });
      });
      expect(Date.now()).toBe(submittedAt);
      expect(api.askJack).toHaveBeenCalledOnce();
      expect(api.askJack.mock.calls[0][0]).toEqual({
        message: "Explain this page",
      });
      const startRequest = vi
        .mocked(fetch)
        .mock.calls.find(
          ([, options]) =>
            JSON.parse(String(options?.body)).type ===
            "voice.listening.started",
        );
      expect(startRequest).toBeDefined();
      if (unresolvedType === "started")
        expect(startRequest![1]?.signal?.aborted).toBe(true);
    },
  );

  it.each([false, true])(
    "routes internal voice commands only for resolved admins (%s)",
    async (isAdmin) => {
      api.getMe.mockResolvedValue({ userId: "voice-user", isAdmin });
      vi.mocked(fetch).mockImplementation(async (input) => {
        if (String(input).includes("/api/admin/agents/commands"))
          return new Response(
            JSON.stringify({
              error: "No internal agent executor is configured.",
            }),
            { status: 501, headers: { "Content-Type": "application/json" } },
          );
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      });
      render(<FloatingJack />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      await act(async () => {
        fireEvent.click(screen.getByLabelText("Talk to Jack"));
      });
      await act(async () => {
        FakeSpeechRecognition.latest!.onresult?.({
          results: [
            { 0: { transcript: "Jack interrupt agent Dex" }, isFinal: true },
          ],
        });
        await vi.advanceTimersByTimeAsync(0);
      });
      const requests = vi.mocked(fetch).mock.calls;
      expect(
        requests.filter(([url]) =>
          String(url).includes("/api/admin/agents/commands"),
        ),
      ).toHaveLength(isAdmin ? 1 : 0);
      const voiceRequests = requests.filter(([url]) =>
        String(url).includes("/api/operational/voice"),
      );
      expect(
        voiceRequests.map(
          ([, options]) => JSON.parse(String(options?.body)).type,
        ),
      ).toEqual(["voice.listening.started", "voice.listening.stopped"]);
      if (isAdmin) {
        expect(api.askJack).not.toHaveBeenCalled();
        expect(
          screen.getByText(
            "No internal agent executor is configured. Command was not executed.",
          ),
        ).toBeTruthy();
      } else expect(api.askJack).toHaveBeenCalledOnce();
    },
  );
});
