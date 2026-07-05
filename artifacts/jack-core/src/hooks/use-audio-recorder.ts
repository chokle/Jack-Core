import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Voice capture for Interview Mode. Wraps getUserMedia + MediaRecorder into a
 * small state machine the UI can drive with one button. The recorded audio is
 * handed back as a Blob for server-side (Whisper) transcription — there is no
 * browser SpeechRecognition involved.
 */
export type RecorderState = "idle" | "requesting" | "recording" | "error";

export type RecorderErrorKind = "unsupported" | "permission" | "no-mic" | "failed";

export interface RecorderError {
  kind: RecorderErrorKind;
  message: string;
}

export interface AudioRecording {
  blob: Blob;
  /** The actual container/codec MediaRecorder produced (used to name the upload). */
  mimeType: string;
  durationMs: number;
}

/**
 * Preferred containers in priority order. Chrome/Firefox support webm/opus;
 * iOS Safari only supports mp4. We never hardcode one — the browser picks the
 * first it can actually record, and we fall back to the platform default.
 */
const PREFERRED_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
];

export function isRecordingSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof MediaRecorder !== "undefined" &&
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === "function"
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

export interface UseAudioRecorder {
  supported: boolean;
  state: RecorderState;
  error: RecorderError | null;
  elapsedMs: number;
  start: () => Promise<void>;
  /** Stop and resolve with the recording, or null if nothing usable was captured. */
  stop: () => Promise<AudioRecording | null>;
  /** Abort recording and discard audio without producing a result. */
  cancel: () => void;
  /** Clear a prior error / elapsed time back to idle (when not recording). */
  reset: () => void;
}

export function useAudioRecorder(): UseAudioRecorder {
  const [supported] = useState(isRecordingSupported);
  const [state, setState] = useState<RecorderState>("idle");
  const [error, setError] = useState<RecorderError | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const stopResolveRef = useRef<((rec: AudioRecording | null) => void) | null>(null);
  // Guards a start() whose getUserMedia promise resolves AFTER the component
  // unmounted or the user cancelled while the permission prompt was open —
  // otherwise the mic gets acquired and left running with no handle to release.
  const mountedRef = useRef(true);
  const abortStartRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const start = useCallback(async () => {
    if (state === "recording" || state === "requesting") return;
    setError(null);
    setElapsedMs(0);
    abortStartRef.current = false;

    if (!isRecordingSupported()) {
      setState("error");
      setError({
        kind: "unsupported",
        message:
          "Voice recording isn't supported in this browser. You can type your answer instead.",
      });
      return;
    }

    setState("requesting");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        setError({
          kind: "permission",
          message:
            "Microphone access was blocked. Allow it in your browser settings, or type your answer instead.",
        });
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        setError({
          kind: "no-mic",
          message: "No microphone was found. Plug one in, or type your answer instead.",
        });
      } else {
        setError({
          kind: "failed",
          message: "Couldn't start recording. Please try again, or type your answer instead.",
        });
      }
      setState("error");
      return;
    }

    if (!mountedRef.current || abortStartRef.current) {
      // Unmounted or cancelled while the permission prompt was open — release
      // the mic we just acquired and bail without ever starting a recording.
      stream.getTracks().forEach((t) => t.stop());
      if (mountedRef.current) setState("idle");
      return;
    }

    streamRef.current = stream;
    const requestedMime = pickMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = requestedMime
        ? new MediaRecorder(stream, { mimeType: requestedMime })
        : new MediaRecorder(stream);
    } catch {
      // Some browsers reject an explicit mimeType — fall back to the default.
      recorder = new MediaRecorder(stream);
    }
    recorderRef.current = recorder;
    chunksRef.current = [];

    recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      // recorder.mimeType is the ACTUAL type used; some blobs report "" so we
      // keep the requested type as a fallback for naming the upload.
      const type = recorder.mimeType || requestedMime || "audio/webm";
      const blob = new Blob(chunksRef.current, { type });
      const durationMs = startedAtRef.current ? Date.now() - startedAtRef.current : 0;
      clearTimer();
      releaseStream();
      recorderRef.current = null;
      chunksRef.current = [];
      setState("idle");
      const resolve = stopResolveRef.current;
      stopResolveRef.current = null;
      resolve?.(blob.size > 0 ? { blob, mimeType: type, durationMs } : null);
    };
    recorder.onerror = () => {
      clearTimer();
      releaseStream();
      recorderRef.current = null;
      chunksRef.current = [];
      setState("error");
      setError({ kind: "failed", message: "Recording stopped unexpectedly. Please try again." });
      const resolve = stopResolveRef.current;
      stopResolveRef.current = null;
      resolve?.(null);
    };

    startedAtRef.current = Date.now();
    recorder.start();
    setState("recording");
    timerRef.current = window.setInterval(() => {
      setElapsedMs(Date.now() - startedAtRef.current);
    }, 200);
  }, [state, clearTimer, releaseStream]);

  const stop = useCallback((): Promise<AudioRecording | null> => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      stopResolveRef.current = resolve;
      try {
        recorder.stop();
      } catch {
        stopResolveRef.current = null;
        clearTimer();
        releaseStream();
        recorderRef.current = null;
        chunksRef.current = [];
        setState("idle");
        resolve(null);
      }
    });
  }, [clearTimer, releaseStream]);

  const cancel = useCallback(() => {
    stopResolveRef.current = null;
    // Abort an in-flight start() whose permission prompt is still open.
    abortStartRef.current = true;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.onstop = null;
      recorder.ondataavailable = null;
      try {
        recorder.stop();
      } catch {
        /* ignore */
      }
    }
    clearTimer();
    releaseStream();
    recorderRef.current = null;
    chunksRef.current = [];
    setElapsedMs(0);
    setState("idle");
  }, [clearTimer, releaseStream]);

  const reset = useCallback(() => {
    setError(null);
    setElapsedMs(0);
    setState((prev) => (prev === "recording" || prev === "requesting" ? prev : "idle"));
  }, []);

  // Unmount cleanup: detach handlers and release the mic so recording never
  // outlives the component (e.g. the mentor navigates away mid-answer).
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      const recorder = recorderRef.current;
      if (recorder) {
        recorder.onstop = null;
        recorder.ondataavailable = null;
        recorder.onerror = null;
        if (recorder.state !== "inactive") {
          try {
            recorder.stop();
          } catch {
            /* ignore */
          }
        }
      }
      stopResolveRef.current = null;
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []);

  return { supported, state, error, elapsedMs, start, stop, cancel, reset };
}
