// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  api.getMe.mockResolvedValue({});
  api.listVideos.mockResolvedValue({
    videos: [{ id: "3g", title: "3gdemo" }],
    total: 1,
  });
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

describe("FloatingJack natural video destination interruption", () => {
  it("interrupts a pending answer and opens 3gdemo from 'Take me to 3G demo' without restoring stale output", async () => {
    let resolveOld!: (value: unknown) => void;
    api.askJack.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );

    const openSource = (event: Event) => {
      const detail = (event as CustomEvent<{ videoId: string }>).detail;
      const surface = document.querySelector<HTMLElement>("section")!;
      surface.dataset.videoId = detail.videoId;
      surface.dataset.videoTitle = "3gdemo";
      surface.dataset.jackPath = '["Library","3gdemo","Transcript"]';
    };
    window.addEventListener("jack:open-video-source", openSource);

    render(
      <>
        <section
          data-jack-surface="Video"
          data-video-id="oxy"
          data-video-title="Oxy"
          data-jack-path='["Library","Oxy","Analysis"]'
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
    const oldSignal = api.askJack.mock.calls[0][1].signal as AbortSignal;

    fireEvent.click(screen.getByLabelText("Talk to Jack"));
    await act(async () => {
      FakeSpeechRecognition.latest!.onresult?.({
        results: [
          { 0: { transcript: "Take me to 3G demo" }, isFinal: true },
        ],
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(oldSignal.aborted).toBe(true);
    expect(api.listVideos.mock.calls[0][0]).toEqual({ limit: 200, offset: 0 });
    expect(document.querySelector<HTMLElement>("section")!.dataset.videoId).toBe(
      "3g",
    );
    expect(screen.getByText(/Jack is with you:/).textContent).toContain(
      "3gdemo",
    );

    await act(async () => {
      resolveOld({
        answer: "Old Oxy explanation",
        citations: [
          {
            sourceType: "video",
            videoId: "oxy",
            videoTitle: "Oxy source",
            startTime: 15,
            endTime: 20,
          },
        ],
      });
      await Promise.resolve();
    });

    expect(screen.queryByText("Old Oxy explanation")).toBeNull();
    expect(screen.queryByRole("button", { name: /Oxy source/ })).toBeNull();
    window.removeEventListener("jack:open-video-source", openSource);
  });
});
