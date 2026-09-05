// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FloatingJack } from "./FloatingJack";

const api = vi.hoisted(() => ({
  askJack: vi.fn(),
  getMe: vi.fn(),
}));

vi.mock("@workspace/api-client-react", () => ({
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
  Object.defineProperty(window, "SpeechRecognition", {
    configurable: true,
    writable: true,
    value: FakeSpeechRecognition,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("FloatingJack submission lifecycle", () => {
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
});
