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
import { setAuthTokenGetter } from "@workspace/api-client-react";

const api = vi.hoisted(() => ({
  askJack: vi.fn(),
  getMe: vi.fn(),
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/api-client-react")>()),
  askJack: api.askJack,
  getMe: api.getMe,
}));

beforeEach(() => {
  vi.useFakeTimers();
  api.askJack.mockReset();
  api.getMe.mockReset().mockResolvedValue({});
  api.askJack.mockResolvedValue({ answer: "A direct field answer." });
  window.history.replaceState({}, "", "/app");
  document.title = "Jack";
  setAuthTokenGetter(() => "rendered-speech-token");
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementation(
        async () => new Response("Unavailable", { status: 503 }),
      ),
  );
});

afterEach(() => {
  cleanup();
  setAuthTokenGetter(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function renderJack() {
  const view = render(<FloatingJack />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  return view;
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

describe("FloatingJack canonical speech output", () => {
  it("keeps the answer readable and shows degraded state if voice is unavailable", async () => {
    await renderJack();
    await submit("What is this?");
    expect(screen.getByText("A direct field answer.")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(
      "voice is unavailable",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Read Jack's answer aloud" }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("shows blocked playback and retries the same cloned audio on a tap", async () => {
    const play = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("blocked", "NotAllowedError"))
      .mockResolvedValue(undefined);
    vi.stubGlobal(
      "Audio",
      class {
        play = play;
        pause = vi.fn();
        removeAttribute = vi.fn();
        onended = null;
        onerror = null;
      },
    );
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL = vi.fn(() => "blob:canonical");
        static revokeObjectURL = vi.fn();
      },
    );
    vi.mocked(fetch).mockImplementation(async (_url, options) => {
      if (
        new Headers(options?.headers).get("authorization") !==
        "Bearer rendered-speech-token"
      )
        return new Response("Unauthorized", { status: 401 });
      return new Response("audio", {
        headers: { "content-type": "audio/mpeg" },
      });
    });
    await renderJack();
    await submit("What is this?");
    expect(screen.getByRole("status").textContent).toContain(
      "playback was blocked",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Read Jack's answer aloud" }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(play).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(
      new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers).get(
        "authorization",
      ),
    ).toBe("Bearer rendered-speech-token");
    expect(screen.getByRole("status").textContent).toBe("Jack is speaking.");
  });
  it("aborts voice on navigation and ignores its late response", async () => {
    let resolve!: (value: unknown) => void;
    vi.mocked(fetch).mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }) as Promise<Response>,
    );
    await renderJack();
    await submit("What is this?");
    const signal = vi.mocked(fetch).mock.calls[0][1]?.signal;
    act(() => {
      window.history.pushState({}, "", "/library");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await act(async () => {
      resolve(new Response("Unavailable", { status: 503 }));
    });
    expect(signal?.aborted).toBe(true);
    expect(screen.queryByRole("status")).toBeNull();
  });
  it("aborts voice after authentication expires", async () => {
    vi.mocked(fetch).mockImplementation(() => new Promise(() => {}));
    await renderJack();
    await submit("What is this?");
    const signal = vi.mocked(fetch).mock.calls[0][1]?.signal;
    api.getMe.mockRejectedValue(new Error("signed out"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(signal?.aborted).toBe(true);
    expect(screen.queryByRole("textbox")).toBeNull();
  });
  it("aborts voice when unmounted", async () => {
    vi.mocked(fetch).mockImplementation(() => new Promise(() => {}));
    const view = await renderJack();
    await submit("What is this?");
    const signal = vi.mocked(fetch).mock.calls[0][1]?.signal;
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });
});
