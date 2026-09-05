import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { JackSpeechPlayer } from "./jack-speech";
const play = vi.fn();
const pause = vi.fn();
const fetchAudio = vi.fn();
const revoke = vi.fn();
let audio: { onended: (() => void) | null; onerror: (() => void) | null };
beforeEach(() => {
  play.mockReset().mockResolvedValue(undefined);
  pause.mockReset();
  revoke.mockReset();
  fetchAudio.mockReset().mockImplementation(
    async () =>
      new Response(new Blob(["audio"]), {
        headers: { "content-type": "audio/mpeg" },
      }),
  );
  vi.stubGlobal("fetch", fetchAudio);
  vi.stubGlobal(
    "Audio",
    class {
      onended = null;
      onerror = null;
      play = play;
      pause = pause;
      removeAttribute = vi.fn();
      constructor() {
        audio = this;
      }
    },
  );
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:voice");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(revoke);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("requests only canonical authenticated audio and releases it after playback", async () => {
  const state = vi.fn();
  const player = new JackSpeechPlayer(state);
  await player.speak("Hello");
  expect(fetchAudio).toHaveBeenCalledWith(
    "/api/jack/speech",
    expect.objectContaining({
      credentials: "include",
      method: "POST",
      body: JSON.stringify({ text: "Hello" }),
    }),
  );
  expect(state).toHaveBeenLastCalledWith("playing");
  audio.onended?.();
  expect(revoke).toHaveBeenCalledWith("blob:voice");
  expect(state).toHaveBeenLastCalledWith("idle");
});
it("does not play a response completing after cancellation", async () => {
  let resolve!: (response: Response) => void;
  fetchAudio.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const player = new JackSpeechPlayer(vi.fn());
  const work = player.speak("Old page");
  const signal = fetchAudio.mock.calls[0][1].signal;
  player.cancel();
  resolve(new Response("audio", { headers: { "content-type": "audio/mpeg" } }));
  await work;
  expect(signal.aborted).toBe(true);
  expect(play).not.toHaveBeenCalled();
});
it("retains blocked audio for synchronous gesture retry without another fetch", async () => {
  play.mockRejectedValueOnce(new DOMException("blocked", "NotAllowedError"));
  const state = vi.fn();
  const player = new JackSpeechPlayer(state);
  await player.speak("Hello");
  expect(state).toHaveBeenLastCalledWith("blocked");
  await player.speak("Hello");
  expect(fetchAudio).toHaveBeenCalledTimes(1);
  expect(play).toHaveBeenCalledTimes(2);
  expect(state).toHaveBeenLastCalledWith("playing");
  player.cancel();
  expect(revoke).toHaveBeenCalled();
});
it.each([503, 401])(
  "exposes unavailable for HTTP %s without device voice fallback",
  async (status) => {
    fetchAudio.mockResolvedValue(new Response("Unavailable", { status }));
    const state = vi.fn();
    await new JackSpeechPlayer(state).speak("Hello");
    expect(state).toHaveBeenLastCalledWith("unavailable");
    expect(play).not.toHaveBeenCalled();
  },
);
it("stops current audio when a new response begins", async () => {
  const player = new JackSpeechPlayer(vi.fn());
  await player.speak("First");
  await player.speak("Second");
  expect(pause).toHaveBeenCalledOnce();
  expect(revoke).toHaveBeenCalledOnce();
  expect(play).toHaveBeenCalledTimes(2);
});

it("ignores late play completion after cancellation", async () => {
  let resolve!: () => void;
  play.mockImplementation(
    () =>
      new Promise<void>((r) => {
        resolve = r;
      }),
  );
  const state = vi.fn();
  const player = new JackSpeechPlayer(state);
  const work = player.speak("First");
  await vi.waitFor(() => expect(play).toHaveBeenCalledOnce());
  player.cancel();
  resolve();
  await work;
  expect(state).not.toHaveBeenCalledWith("playing");
  expect(revoke).toHaveBeenCalledOnce();
});
it("rejects non-audio and empty success responses", async () => {
  const state = vi.fn();
  const player = new JackSpeechPlayer(state);
  fetchAudio.mockResolvedValueOnce(
    new Response("{}", { headers: { "content-type": "application/json" } }),
  );
  await player.speak("First");
  expect(state).toHaveBeenLastCalledWith("unavailable");
  fetchAudio.mockResolvedValueOnce(
    new Response("", { headers: { "content-type": "audio/mpeg" } }),
  );
  await player.speak("Second");
  expect(state).toHaveBeenLastCalledWith("unavailable");
  expect(play).not.toHaveBeenCalled();
});

it("reports unavailable and releases retained audio when retry cannot decode", async () => {
  play.mockRejectedValueOnce(new DOMException("blocked", "NotAllowedError"));
  const state = vi.fn();
  const player = new JackSpeechPlayer(state);
  await player.speak("Hello");
  play.mockRejectedValueOnce(
    new DOMException("bad audio", "NotSupportedError"),
  );
  await player.speak("Hello");
  expect(state).toHaveBeenLastCalledWith("unavailable");
  expect(revoke).toHaveBeenCalledOnce();
});

it("bounds a stalled network request and exposes unavailable", async () => {
  vi.useFakeTimers();
  fetchAudio.mockImplementation(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      }),
  );
  const state = vi.fn();
  const player = new JackSpeechPlayer(state);
  const request = player.speak("Hello");
  await vi.advanceTimersByTimeAsync(40_000);
  await request;
  expect(fetchAudio.mock.calls[0][1].signal.aborted).toBe(true);
  expect(state).toHaveBeenLastCalledWith("unavailable");
  expect(vi.getTimerCount()).toBe(0);
});
it("clears the deadline on external cancel without reporting unavailable", async () => {
  vi.useFakeTimers();
  fetchAudio.mockImplementation(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      }),
  );
  const state = vi.fn();
  const player = new JackSpeechPlayer(state);
  const request = player.speak("Hello");
  player.cancel();
  await request;
  await vi.advanceTimersByTimeAsync(40_000);
  expect(state).not.toHaveBeenCalledWith("unavailable");
  expect(vi.getTimerCount()).toBe(0);
});
it("clears the network deadline once audio has loaded", async () => {
  vi.useFakeTimers();
  const state = vi.fn();
  const player = new JackSpeechPlayer(state);
  await player.speak("Hello");
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(40_000);
  expect(state).toHaveBeenLastCalledWith("playing");
  player.cancel();
});
