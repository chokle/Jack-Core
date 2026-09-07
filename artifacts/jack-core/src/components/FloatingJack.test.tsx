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
  listVideos: vi.fn(),
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/api-client-react")>()),
  askJack: api.askJack,
  getMe: api.getMe,
  listVideos: api.listVideos,
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
  api.listVideos.mockReset();
  api.listVideos.mockResolvedValue({ videos: [], total: 0 });
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
  it("interrupts the 15-second explanation and opens a catalog video by its natural spoken name", async () => {
    let finishOld!: (value: unknown) => void;
    api.askJack.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    );
    api.listVideos.mockResolvedValue({
      videos: [{ id: "three-g", title: "3gdemo" }],
      total: 1,
    });
    const open = vi.fn((event: Event) => {
      const section = document.querySelector("section")!;
      section.dataset.videoId = (event as CustomEvent).detail.videoId;
      section.dataset.videoTitle = "3gdemo";
      section.dataset.jackPath = '["Library","3gdemo","Transcript"]';
    });
    window.addEventListener("jack:open-video-source", open);
    try {
      render(
        <>
          <section
            data-jack-surface="Video"
            data-video-id="oxy"
            data-video-title="Oxy"
            data-jack-path='["Library","Oxy","Transcript"]'
          />
          <FloatingJack />
        </>,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      fireEvent.change(screen.getByLabelText("Ask Jack"), {
        target: { value: "Summarize what happened at 15 seconds" },
      });
      fireEvent.click(screen.getByLabelText("Send to Jack"));
      fireEvent.click(screen.getByLabelText("Talk to Jack"));
      await act(async () => {
        FakeSpeechRecognition.latest!.onresult?.({
          results: [{ 0: { transcript: "Take me to 3G demo" }, isFinal: true }],
        });
      });
      expect(open).toHaveBeenCalledOnce();
      expect((open.mock.calls[0][0] as CustomEvent).detail).toEqual({
        videoId: "three-g",
      });
      await act(async () => {
        finishOld({ answer: "Stale Oxy answer", citations: [] });
      });
      expect(screen.queryByText("Stale Oxy answer")).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
      expect(screen.getByText(/Jack is with you:/).textContent).toContain(
        "3gdemo",
      );
      expect(api.askJack).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener("jack:open-video-source", open);
    }
  });

  it("discards a pending destination lookup when the selected screen changes", async () => {
    let finishLookup!: (value: unknown) => void;
    api.listVideos.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishLookup = resolve;
        }),
    );
    const open = vi.fn();
    window.addEventListener("jack:open-video-source", open);
    try {
      render(
        <>
          <section data-jack-surface="Library" />
          <FloatingJack />
        </>,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      fireEvent.change(screen.getByLabelText("Ask Jack"), {
        target: { value: "Take me to 3G demo" },
      });
      fireEvent.click(screen.getByLabelText("Send to Jack"));
      await act(async () => {
        document.querySelector("section")!.dataset.jackSurface = "Interview";
      });
      await act(async () => {
        finishLookup({
          videos: [{ id: "three-g", title: "3gdemo" }],
          total: 1,
        });
      });
      expect(open).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("jack:open-video-source", open);
    }
  });

  it.each(["listening", "recognition error", "no speech", "start error"])(
    "never resumes interrupted audio or answers after %s",
    async (mode) => {
      let resolveOld!: (value: unknown) => void;
      api.askJack.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      );
      api.askJack.mockResolvedValue({ answer: "Retry answer" });
      render(<FloatingJack />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      fireEvent.change(screen.getByLabelText("Ask Jack"), {
        target: { value: "Old question" },
      });
      fireEvent.click(screen.getByLabelText("Send to Jack"));
      if (mode === "start error") {
        window.SpeechRecognition = class extends FakeSpeechRecognition {
          start = vi.fn(() => {
            throw new Error("Microphone unavailable");
          });
        };
      }
      fireEvent.click(screen.getByLabelText("Talk to Jack"));
      expect(api.askJack.mock.calls[0][1].signal.aborted).toBe(true);
      const recognition = FakeSpeechRecognition.latest!;
      await act(async () => {
        if (mode === "recognition error") recognition.onerror?.({});
        if (mode === "no speech") recognition.onend?.();
        resolveOld({
          answer: "Cancelled answer",
          citations: [
            {
              sourceType: "video",
              videoId: "oxy",
              videoTitle: "Cancelled source",
              startTime: 1,
              endTime: 3,
            },
          ],
        });
      });
      expect(screen.queryByText("Cancelled answer")).toBeNull();
      expect(
        screen.queryByRole("button", { name: /Cancelled source/ }),
      ).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
      fireEvent.change(screen.getByLabelText("Ask Jack"), {
        target: { value: "Retry question" },
      });
      await act(async () => {
        fireEvent.click(screen.getByLabelText("Send to Jack"));
      });
      expect(screen.getByText("Retry answer")).toBeTruthy();
    },
  );

  it("interrupts a pending explanation with voice video navigation and rejects the old answer", async () => {
    let resolveOld!: (value: unknown) => void;
    api.askJack.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    const navigate = vi.fn(() => {
      const surface = document.querySelector("section")!;
      surface.dataset.videoId = "3gdemo";
      surface.dataset.jackPath = '["Library","3gdemo","Transcript"]';
    });
    render(
      <>
        <section
          data-jack-surface="Video"
          data-video-id="oxy"
          data-jack-path='["Library","Oxy","Analysis"]'
        />
        <button
          data-jack-action="video"
          data-video-title="3gdemo"
          onClick={navigate}
        >
          3gdemo
        </button>
        <FloatingJack />
      </>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    fireEvent.change(screen.getByLabelText("Ask Jack"), {
      target: { value: "Explain Oxy" },
    });
    fireEvent.click(screen.getByLabelText("Send to Jack"));
    const oldSignal = api.askJack.mock.calls[0][1].signal;
    fireEvent.click(screen.getByLabelText("Talk to Jack"));
    await act(async () => {
      FakeSpeechRecognition.latest!.onresult?.({
        results: [{ 0: { transcript: "Open video 3gdemo" }, isFinal: true }],
      });
    });
    expect(navigate).toHaveBeenCalledOnce();
    expect(oldSignal.aborted).toBe(true);
    await act(async () => {
      resolveOld({
        answer: "Old Oxy explanation",
        citations: [
          {
            sourceType: "video",
            videoId: "oxy",
            videoTitle: "Oxy source",
            startTime: 20,
            endTime: 30,
          },
        ],
      });
    });
    expect(screen.queryByText("Old Oxy explanation")).toBeNull();
    expect(screen.queryByRole("button", { name: /Oxy source/ })).toBeNull();
    expect(screen.getByText(/Jack is with you:/).textContent).toContain(
      "3gdemo",
    );
  });

  it("lets a new voice question own the pending state even when the cancelled answer arrives late", async () => {
    const resolve: Array<(value: unknown) => void> = [];
    api.askJack.mockImplementation(
      () =>
        new Promise((done) => {
          resolve.push(done);
        }),
    );
    render(<FloatingJack />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    fireEvent.change(screen.getByLabelText("Ask Jack"), {
      target: { value: "Old question" },
    });
    fireEvent.click(screen.getByLabelText("Send to Jack"));
    fireEvent.click(screen.getByLabelText("Talk to Jack"));
    await act(async () => {
      FakeSpeechRecognition.latest!.onresult?.({
        results: [{ 0: { transcript: "New question" }, isFinal: true }],
      });
    });
    expect(api.askJack).toHaveBeenCalledTimes(2);
    await act(async () => {
      resolve[0]({ answer: "Old answer" });
    });
    expect(screen.queryByText("Old answer")).toBeNull();
    fireEvent.change(screen.getByLabelText("Ask Jack"), {
      target: { value: "Unsent draft" },
    });
    expect(
      (screen.getByLabelText("Send to Jack") as HTMLButtonElement).disabled,
    ).toBe(true);
    await act(async () => {
      resolve[1]({ answer: "New answer" });
    });
    expect(screen.getByText("New answer")).toBeTruthy();
  });

  it("sends the selected Library resource and opens returned timestamp sources", async () => {
    api.askJack.mockResolvedValue({
      answer: "The video shows an EMT offset.",
      citations: [
        {
          sourceType: "video",
          videoId: "e3",
          videoTitle: "EMT Offset",
          startTime: 80,
          endTime: 89,
        },
      ],
    });
    render(
      <>
        <section
          data-jack-surface="Video"
          data-video-id="e3"
          data-video-title="EMT Offset"
          data-video-trade="electrician"
          data-video-status="completed"
        />
        <FloatingJack />
      </>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    const input = screen.getByRole("textbox", { name: "Ask Jack" });
    fireEvent.change(input, {
      target: { value: "What is this video showing me?" },
    });
    await act(async () => {
      fireEvent.submit(input.closest("form")!);
    });
    const context = JSON.parse(
      decodeURIComponent(
        api.askJack.mock.calls[0][1].headers["X-Jack-Context"],
      ),
    );
    expect(context.resources[0]).toMatchObject({
      id: "e3",
      title: "EMT Offset",
      selected: true,
    });
    const opened = vi.fn();
    window.addEventListener("jack:open-video-source", opened);
    fireEvent.click(screen.getByRole("button", { name: "EMT Offset · 1:20" }));
    expect(opened.mock.calls[0][0].detail).toEqual({
      videoId: "e3",
      startTime: 80,
    });
    window.removeEventListener("jack:open-video-source", opened);
  });
  it("opens analysis-only evidence without an invented timestamp", async () => {
    api.askJack.mockResolvedValue({
      answer: "Saved analysis.",
      citations: [
        {
          sourceType: "video",
          videoId: "e3",
          videoTitle: "EMT Offset",
          startTime: 0,
          endTime: 0,
        },
      ],
    });
    render(<FloatingJack />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    const input = screen.getByRole("textbox", { name: "Ask Jack" });
    fireEvent.change(input, { target: { value: "Describe the video" } });
    await act(async () => {
      fireEvent.submit(input.closest("form")!);
    });
    const opened = vi.fn();
    window.addEventListener("jack:open-video-source", opened);
    fireEvent.click(
      screen.getByRole("button", { name: /EMT Offset.*Open video/ }),
    );
    expect(opened.mock.calls[0][0].detail).toEqual({
      videoId: "e3",
      startTime: undefined,
    });
    expect(screen.queryByText(/0:00/)).toBeNull();
    window.removeEventListener("jack:open-video-source", opened);
  });

  it("discards an answer and its sources when the selected video tab changes during retrieval", async () => {
    let resolve!: (value: unknown) => void;
    api.askJack.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    render(
      <>
        <section
          data-jack-surface="Video"
          data-video-id="e3"
          data-jack-path='["Library","E3","Analysis"]'
        />
        <FloatingJack />
      </>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    const input = screen.getByRole("textbox", { name: "Ask Jack" });
    fireEvent.change(input, { target: { value: "Describe this video" } });
    fireEvent.submit(input.closest("form")!);
    await act(async () => {
      document
        .querySelector("section")!
        .setAttribute("data-jack-path", '["Library","E3","Transcript"]');
      resolve({
        answer: "Old analysis answer",
        citations: [
          {
            sourceType: "video",
            videoId: "e3",
            videoTitle: "Old source",
            startTime: 80,
            endTime: 90,
          },
        ],
      });
    });
    expect(api.askJack.mock.calls[0][1].signal.aborted).toBe(true);
    expect(screen.queryByText("Old analysis answer")).toBeNull();
    expect(screen.queryByRole("button", { name: /Old source/ })).toBeNull();
  });

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
