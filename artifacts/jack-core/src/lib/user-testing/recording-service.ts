/**
 * Beta user-testing mode — screen(+mic) recorder.
 *
 * Deliberately framework-agnostic (no React state) so any future testing mode
 * can reuse it: callers own their own UI state and poll `elapsedMs()` on a
 * timer if they want a live readout. Mirrors the browser-API conventions of
 * `hooks/use-audio-recorder.ts` (feature detection, mime fallback list) but
 * captures the screen (getDisplayMedia) instead of just the mic.
 *
 * SAFETY: `start()` must only ever be called after the user has explicitly
 * consented (e.g. clicking "Start Test" in UserTestingModal). Never call it
 * on mount, on `?test=true`, or anywhere permissions could be requested
 * before the user has seen and accepted the consent copy.
 */

export type RecordingStopReason = "user" | "native-stop-sharing" | "error";

export interface TestRecordingResult {
  blob: Blob;
  mimeType: string;
  durationMs: number;
  screenResolution: string;
  micIncluded: boolean;
  stopReason: RecordingStopReason;
}

export interface RecordingServiceCallbacks {
  /** Fired once when recording ends for any reason (Stop Test, native "stop
   *  sharing", or an internal error) — the natural place to trigger upload. */
  onStop?: (result: TestRecordingResult) => void;
  onError?: (error: Error) => void;
}

// Chrome/Firefox support webm; Safari's screen-capture support is limited and
// falls back to whatever MediaRecorder.isTypeSupported allows (often none, in
// which case the browser default container is used).
const PREFERRED_MIME_TYPES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4",
];

export function isScreenRecordingSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof MediaRecorder !== "undefined" &&
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getDisplayMedia === "function"
  );
}

function pickMimeType(): string | undefined {
  if (
    typeof MediaRecorder === "undefined" ||
    typeof MediaRecorder.isTypeSupported !== "function"
  ) {
    return undefined;
  }
  return PREFERRED_MIME_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
}

export class RecordingService {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private mimeType = "";
  private micDenied = false;
  private startedAt = 0;
  private pausedAt = 0;
  private pausedAccumulated = 0;
  private stopped = false;
  private callbacks: RecordingServiceCallbacks;

  constructor(callbacks: RecordingServiceCallbacks = {}) {
    this.callbacks = callbacks;
  }

  get isRecording(): boolean {
    return this.recorder?.state === "recording";
  }

  get isPaused(): boolean {
    return this.recorder?.state === "paused";
  }

  get micIncluded(): boolean {
    return !this.micDenied && (this.stream?.getAudioTracks().length ?? 0) > 0;
  }

  /** Elapsed recording time, excluding any paused duration. */
  elapsedMs(): number {
    if (!this.startedAt) return 0;
    const pausedNow = this.pausedAt ? Date.now() - this.pausedAt : 0;
    return Date.now() - this.startedAt - this.pausedAccumulated - pausedNow;
  }

  /**
   * Request screen capture, then — if the browser didn't already include
   * system/tab audio — separately request mic permission and merge its track
   * in. Mic denial is non-fatal: recording continues screen-only per spec.
   */
  async start(): Promise<void> {
    if (!isScreenRecordingSupported()) {
      throw new Error("Screen recording is not supported in this browser.");
    }

    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });

    if (
      displayStream.getAudioTracks().length === 0 &&
      typeof navigator.mediaDevices.getUserMedia === "function"
    ) {
      try {
        const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        for (const track of micStream.getAudioTracks()) {
          displayStream.addTrack(track);
        }
      } catch {
        this.micDenied = true;
      }
    }

    this.stream = displayStream;

    // The browser's native "Stop sharing" control ends the video track
    // out-of-band — treat that exactly like our own Stop Test button so the
    // recording is never silently lost.
    const videoTrack = displayStream.getVideoTracks()[0];
    videoTrack?.addEventListener("ended", () => {
      void this.stop("native-stop-sharing");
    });

    this.mimeType = pickMimeType() ?? "";
    try {
      this.recorder = this.mimeType
        ? new MediaRecorder(displayStream, { mimeType: this.mimeType })
        : new MediaRecorder(displayStream);
    } catch (err) {
      this.releaseTracks();
      throw err instanceof Error ? err : new Error("Failed to start MediaRecorder");
    }

    this.chunks = [];
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.onerror = () => {
      this.callbacks.onError?.(new Error("MediaRecorder encountered an error"));
    };

    this.startedAt = Date.now();
    // A 1s timeslice keeps chunks flowing for long sessions instead of
    // buffering the whole recording in memory until stop() is called.
    this.recorder.start(1000);
  }

  pause(): void {
    if (this.recorder?.state !== "recording") return;
    this.recorder.pause();
    this.pausedAt = Date.now();
  }

  resume(): void {
    if (this.recorder?.state !== "paused") return;
    this.recorder.resume();
    this.pausedAccumulated += Date.now() - this.pausedAt;
    this.pausedAt = 0;
  }

  /** Stop recording (idempotent) and resolve with the captured Blob, or null if nothing was captured. */
  async stop(reason: RecordingStopReason = "user"): Promise<TestRecordingResult | null> {
    if (this.stopped) return null;
    this.stopped = true;

    const recorder = this.recorder;
    const durationMs = this.elapsedMs();
    const screenResolution = this.captureResolution();
    const micIncluded = this.micIncluded;
    const mimeType = this.mimeType;

    const blob = await new Promise<Blob | null>((resolve) => {
      if (!recorder || recorder.state === "inactive") {
        resolve(this.chunks.length ? new Blob(this.chunks, { type: mimeType || "video/webm" }) : null);
        return;
      }
      recorder.onstop = () => {
        resolve(this.chunks.length ? new Blob(this.chunks, { type: mimeType || "video/webm" }) : null);
      };
      recorder.stop();
    });

    this.releaseTracks();

    if (!blob) return null;

    const result: TestRecordingResult = {
      blob,
      mimeType: mimeType || blob.type || "video/webm",
      durationMs,
      screenResolution,
      micIncluded,
      stopReason: reason,
    };
    this.callbacks.onStop?.(result);
    return result;
  }

  /** Abort recording and discard captured data (e.g. consent revoked mid-flow). */
  cancel(): void {
    if (this.stopped) return;
    this.stopped = true;
    try {
      this.recorder?.stop();
    } catch {
      /* ignore */
    }
    this.chunks = [];
    this.releaseTracks();
  }

  private captureResolution(): string {
    const settings = this.stream?.getVideoTracks()[0]?.getSettings();
    if (settings?.width && settings?.height) return `${settings.width}x${settings.height}`;
    if (typeof window !== "undefined" && window.screen) {
      return `${window.screen.width}x${window.screen.height}`;
    }
    return "unknown";
  }

  private releaseTracks(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}
