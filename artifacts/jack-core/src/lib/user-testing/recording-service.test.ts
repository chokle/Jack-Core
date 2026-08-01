// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RecordingService } from "./recording-service";

function stream() {
  const tracks: Array<{ stop: ReturnType<typeof vi.fn> }> = [];
  const videoTrack = {
    stop: vi.fn(),
    addEventListener: vi.fn(),
    getSettings: vi.fn(() => ({ width: 1280, height: 720 })),
  };
  tracks.push(videoTrack);
  return {
    getVideoTracks: () => [videoTrack],
    getAudioTracks: () => tracks.slice(1),
    getTracks: () => tracks,
    addTrack: (track: { stop: ReturnType<typeof vi.fn> }) => tracks.push(track),
  } as unknown as MediaStream;
}

describe("RecordingService microphone boundary", () => {
  const getDisplayMedia = vi.fn();
  const getUserMedia = vi.fn();

  beforeEach(() => {
    getDisplayMedia.mockReset().mockResolvedValue(stream());
    getUserMedia.mockReset().mockResolvedValue({
      getAudioTracks: () => [{ stop: vi.fn() }],
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getDisplayMedia, getUserMedia },
    });
    class Recorder {
      static isTypeSupported = () => true;
      state = "inactive";
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      onstop: (() => void) | null = null;
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.onstop?.();
      }
      pause() {}
      resume() {}
    }
    vi.stubGlobal("MediaRecorder", Recorder);
  });

  it("never requests microphone by default", async () => {
    const service = new RecordingService();
    await service.start();
    expect(getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: false });
    expect(getUserMedia).not.toHaveBeenCalled();
    service.cancel();
  });

  it("requests microphone only after an explicit true option", async () => {
    const service = new RecordingService();
    await service.start(true);
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    service.cancel();
  });
});
