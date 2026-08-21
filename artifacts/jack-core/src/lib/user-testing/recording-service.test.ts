// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordingService } from "./recording-service";

interface FakeMediaStreamTrack {
  stop: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  getSettings: ReturnType<typeof vi.fn>;
  onEnded?: () => void;
}

interface FakeMediaStream {
  tracks: Array<FakeMediaStreamTrack>;
  getVideoTracks: ReturnType<typeof vi.fn>;
  getAudioTracks: ReturnType<typeof vi.fn>;
  getTracks: ReturnType<typeof vi.fn>;
  addTrack: ReturnType<typeof vi.fn>;
}

function createDisplayTrack(): FakeMediaStreamTrack {
  const track: FakeMediaStreamTrack = {
    stop: vi.fn(),
    addEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === "ended" && typeof listener === "function") {
        track.onEnded = listener;
      }
    }),
    getSettings: vi.fn(() => ({ width: 1280, height: 720 })),
  };
  return track;
}

function createDisplayStream(track: FakeMediaStreamTrack): FakeMediaStream {
  const audioTrack = { stop: vi.fn() };
  const tracks = [track, audioTrack];
  return {
    tracks,
    getVideoTracks: vi.fn(() => [track]),
    getAudioTracks: vi.fn(() => []),
    getTracks: vi.fn(() => tracks),
    addTrack: vi.fn((audio: { stop: ReturnType<typeof vi.fn> }) =>
      tracks.push(audio),
    ),
  };
}

function createRecorderClass(onReady: () => void) {
  return class Recorder {
    static isTypeSupported = vi.fn(() => true);
    state = "inactive";
    ondataavailable: ((event: BlobEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    onstop: (() => void) | null = null;
    onpause: (() => void) | null = null;
    onresume: (() => void) | null = null;

    constructor() {
      onReady();
    }

    start() {
      this.state = "recording";
    }
    stop() {
      if (this.state === "inactive") return;
      this.state = "inactive";
      this.onstop?.();
    }
    pause() {
      if (this.state !== "recording") return;
      this.state = "paused";
      this.onpause?.();
    }
    resume() {
      if (this.state !== "paused") return;
      this.state = "recording";
      this.onresume?.();
    }
  };
}

describe("RecordingService lifecycle", () => {
  let displayTrack: FakeMediaStreamTrack;
  let displayStream: FakeMediaStream;
  const getDisplayMedia = vi.fn();
  const getUserMedia = vi.fn();
  const originalDateNow = Date.now;
  let now = 0;

  beforeEach(() => {
    displayTrack = createDisplayTrack();
    displayStream = createDisplayStream(displayTrack);
    displayTrack.onEnded = undefined;
    // eslint-disable-next-line no-unsafe-constant
    (Date as unknown as { now: () => number }).now = () => now;

    getDisplayMedia.mockReset().mockResolvedValue(displayStream);
    getUserMedia
      .mockReset()
      .mockResolvedValue({ getAudioTracks: vi.fn(() => [{ stop: vi.fn() }]) });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getDisplayMedia, getUserMedia },
    });
    vi.stubGlobal(
      "MediaRecorder",
      createRecorderClass(() => {}),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    (Date as unknown as { now: () => number }).now = originalDateNow;
  });

  it("freezes elapsed time while paused and resumes accumulation correctly", async () => {
    const service = new RecordingService();
    const base = new Date("2026-08-10T00:00:00.000Z").getTime();
    now = base;
    await service.start();
    expect(displayTrack.onEnded).toEqual(expect.any(Function));

    now = base + 5_000;
    const startedElapsed = service.elapsedMs();
    expect(startedElapsed).toBeGreaterThanOrEqual(4_900);

    const paused = service.pause();
    expect(paused).toBe(true);
    now = base + 15_000;
    const pauseElapsed = service.elapsedMs();
    expect(pauseElapsed).toBe(startedElapsed);

    const resumed = service.resume();
    expect(resumed).toBe(true);
    now = base + 25_000;
    const afterResumeElapsed = service.elapsedMs();
    expect((service as { startedAt: number }).startedAt).toBe(base);
    expect((service as { pausedAccumulated: number }).pausedAccumulated).toBe(
      10_000,
    );
    expect(afterResumeElapsed).toBeGreaterThanOrEqual(pauseElapsed + 9_000);
    expect(afterResumeElapsed).toBeLessThanOrEqual(pauseElapsed + 11_000);

    const result = await service.stop("user");
    expect(result).toBeNull();
  });

  it("invokes stop exactly once when called repeatedly, including native stop share", async () => {
    const onStop = vi.fn();
    const onPauseStateChange = vi.fn();
    const service = new RecordingService({ onStop, onPauseStateChange });
    await service.start();

    const first = service.stop("user");
    const second = service.stop("user");
    const third = service.stop("native-stop-sharing");
    await Promise.all([first, second, third]);
    expect(onPauseStateChange).toHaveBeenLastCalledWith(false);
    expect(onStop).toHaveBeenCalledTimes(1);

    service.pause();
    expect(onPauseStateChange).toHaveBeenCalledWith(false);
  });

  it("finalizes when browser share ends and still allows a follow-up stop click", async () => {
    const onStop = vi.fn();
    const service = new RecordingService({ onStop });
    const base = new Date("2026-08-10T00:00:00.000Z").getTime();
    now = base;
    await service.start();
    expect(displayTrack.onEnded).toEqual(expect.any(Function));

    displayTrack.onEnded?.();
    const first = await service.stop("native-stop-sharing");
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(first).toBeNull();

    const second = await service.stop("user");
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(second).toBeNull();
  });
});
