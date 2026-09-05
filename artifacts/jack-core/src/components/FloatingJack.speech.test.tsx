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

vi.mock("@workspace/api-client-react", () => ({
  askJack: api.askJack,
  getMe: api.getMe,
}));

class FakeUtterance {
  rate = 1;
  pitch = 1;
  voice: SpeechSynthesisVoice | null = null;

  constructor(readonly text: string) {}
}

function voice(
  name: string,
  lang: string,
  voiceURI = name,
): SpeechSynthesisVoice {
  return {
    default: false,
    lang,
    localService: true,
    name,
    voiceURI,
  } as SpeechSynthesisVoice;
}

function makeSpeechSynthesis() {
  let voices: SpeechSynthesisVoice[] = [];
  const listeners = new Set<() => void>();
  const synthesis = {
    cancel: vi.fn(),
    speak: vi.fn(),
    getVoices: vi.fn(() => voices),
    addEventListener: vi.fn(
      (event: string, listener: EventListenerOrEventListenerObject) => {
        if (event === "voiceschanged") listeners.add(listener as () => void);
      },
    ),
    removeEventListener: vi.fn(
      (event: string, listener: EventListenerOrEventListenerObject) => {
        if (event === "voiceschanged") listeners.delete(listener as () => void);
      },
    ),
    setVoices(next: SpeechSynthesisVoice[]) {
      voices = next;
    },
    emitVoicesChanged() {
      for (const listener of listeners) listener();
    },
  };
  return synthesis;
}

beforeEach(() => {
  vi.useFakeTimers();
  api.askJack.mockReset();
  api.getMe.mockReset().mockResolvedValue({});
  api.askJack.mockResolvedValue({ answer: "A direct field answer." });
  window.history.replaceState({}, "", "/app");
  document.title = "Jack";
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function renderJack(synthesis: ReturnType<typeof makeSpeechSynthesis>) {
  vi.stubGlobal("speechSynthesis", synthesis);
  render(<FloatingJack />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
}

async function submit(message: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "Ask Jack" }), {
    target: { value: message },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send to Jack" }));
  await act(async () => {
    await Promise.resolve();
  });
}

describe("FloatingJack speech output", () => {
  it("speaks with the selected masculine voice and a steady field register", async () => {
    const synthesis = makeSpeechSynthesis();
    const female = voice("Google US English Female", "en-US");
    const male = voice("Google US English Male", "en-US");
    synthesis.setVoices([female, male]);
    await renderJack(synthesis);

    await submit("What is this?");

    expect(synthesis.speak).toHaveBeenCalledOnce();
    const utterance = synthesis.speak.mock.calls[0][0] as FakeUtterance;
    expect(utterance.voice).toBe(male);
    expect(utterance.rate).toBe(0.96);
    expect(utterance.pitch).toBe(0.88);
  });

  it("waits for Chrome's delayed voice list before speaking", async () => {
    const synthesis = makeSpeechSynthesis();
    await renderJack(synthesis);

    await submit("Where am I?");
    expect(synthesis.speak).not.toHaveBeenCalled();
    expect(synthesis.addEventListener).toHaveBeenCalledWith(
      "voiceschanged",
      expect.any(Function),
      { once: true },
    );

    const male = voice("Google UK English Male", "en-GB");
    synthesis.setVoices([male]);
    act(() => synthesis.emitVoicesChanged());

    expect(synthesis.speak).toHaveBeenCalledOnce();
    expect((synthesis.speak.mock.calls[0][0] as FakeUtterance).voice).toBe(
      male,
    );
    expect(synthesis.removeEventListener).toHaveBeenCalledOnce();
  });

  it("cancels a delayed utterance when page context changes", async () => {
    const synthesis = makeSpeechSynthesis();
    await renderJack(synthesis);
    await submit("What is this?");
    expect(synthesis.speak).not.toHaveBeenCalled();

    act(() => {
      window.history.pushState({}, "", "/library");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(synthesis.cancel).toHaveBeenCalled();
    synthesis.setVoices([voice("Google UK English Male", "en-GB")]);
    act(() => synthesis.emitVoicesChanged());
    expect(synthesis.speak).not.toHaveBeenCalled();
  });
});
