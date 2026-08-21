import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { useToast } from "@/hooks/use-toast";
import {
  RecordingService,
  isScreenRecordingSupported,
  type TestRecordingResult,
} from "@/lib/user-testing/recording-service";
import { uploadTestRecording } from "@/lib/user-testing/upload-service";
import {
  getCachedTestSession,
  loadCurrentTestSession,
  trackTestEvent,
} from "@/lib/user-testing/test-session-service";
import { UserTestingModal } from "./UserTestingModal";
import { RecordingIndicator } from "./RecordingIndicator";
import { ThinkAloudBanner } from "./ThinkAloudBanner";

type Phase = "idle" | "consent" | "recording" | "uploading";
type TestSessionState = "running" | "paused" | "completing" | "completed";
type RecordingState =
  | "not_requested"
  | "recording"
  | "paused"
  | "stopping"
  | "stopped"
  | "failed";

export interface TestingOverlayHandle {
  open: () => void;
}

export type TestingOverlayEvent =
  | "consent_opened"
  | "started"
  | "declined"
  | "unavailable"
  | "cancelled"
  | "stopped";

interface TestingOverlayProps {
  onEvent?: (event: TestingOverlayEvent) => void;
}

/**
 * Optional recording controller. Base telemetry consent and pilot-session
 * creation happen before this component is opened. Neither screen nor mic
 * permission is requested until the user clicks the modal's start button.
 */
export const TestingOverlay = forwardRef<
  TestingOverlayHandle,
  TestingOverlayProps
>(function TestingOverlay({ onEvent }, ref) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [isPaused, setIsPaused] = useState(false);
  const [micIncluded, setMicIncluded] = useState(false);
  const [showBanner, setShowBanner] = useState(false);
  const serviceRef = useRef<RecordingService | null>(null);
  const { toast } = useToast();
  const sessionStateRef = useRef<TestSessionState>("completed");
  const recordingStateRef = useRef<RecordingState>("not_requested");
  const completionInProgressRef = useRef(false);
  const sessionStartedAtRef = useRef(0);
  const sessionPausedAtRef = useRef(0);
  const sessionPausedAccumMsRef = useRef(0);

  const setSessionState = useCallback((next: TestSessionState) => {
    sessionStateRef.current = next;
    if (next === "paused") {
      setIsPaused(true);
    } else {
      setIsPaused(false);
    }
  }, []);

  const setRecordingState = useCallback((next: RecordingState) => {
    recordingStateRef.current = next;
  }, []);

  const resetSessionClock = useCallback(() => {
    sessionStartedAtRef.current = 0;
    sessionPausedAtRef.current = 0;
    sessionPausedAccumMsRef.current = 0;
  }, []);

  const open = useCallback(() => {
    setPhase((current) => {
      if (current !== "idle") return current;
      onEvent?.("consent_opened");
      return "consent";
    });
  }, [onEvent]);
  useImperativeHandle(ref, () => ({ open }), [open]);

  useEffect(() => {
    const withdraw = () => {
      serviceRef.current?.cancel();
      serviceRef.current = null;
      completionInProgressRef.current = false;
      setSessionState("completed");
      setRecordingState("not_requested");
      resetSessionClock();
      setShowBanner(false);
      setPhase("idle");
    };
    window.addEventListener("jack:telemetry-withdrawn", withdraw);
    return () =>
      window.removeEventListener("jack:telemetry-withdrawn", withdraw);
  }, [resetSessionClock, setRecordingState, setSessionState]);

  const handleUpload = useCallback(
    async (result: TestRecordingResult | null) => {
      const session = getCachedTestSession();
      if (!session) {
        setRecordingState("not_requested");
        setSessionState("completed");
        setPhase("idle");
        return;
      }
      if (!result) {
        setRecordingState("failed");
        return;
      }
      void trackTestEvent("recording_stopped", {
        stop_reason:
          result.stopReason === "native-stop-sharing"
            ? "native_stop_sharing"
            : result.stopReason,
      });
      setRecordingState("stopping");
      const outcome = await uploadTestRecording(result.blob, {
        sessionId: session.id,
        timestamp: new Date().toISOString(),
        durationMs: result.durationMs,
        mimeType: result.mimeType,
        microphoneIncluded: result.micIncluded,
        appVersion: import.meta.env.VITE_APP_VERSION,
      });

      if (outcome.status === "uploaded") {
        void trackTestEvent(
          "recording_upload_succeeded",
          {},
          `recording_upload:${outcome.id}`,
        );
        toast({
          title: "Test recording uploaded",
          description: "Thanks for helping us improve Jack.",
        });
      } else {
        void trackTestEvent(
          "recording_upload_failed",
          { error_code: "upload_failed" },
          `recording_upload_failed:${session.id}`,
        );
        toast({
          title: "Saved recording to your downloads",
          description: `The upload failed, so "${outcome.filename}" was downloaded for you.`,
        });
      }
      setRecordingState("stopped");
    },
    [setRecordingState, setSessionState, toast],
  );

  const getSessionElapsedMs = useCallback(() => {
    if (!sessionStartedAtRef.current) return 0;
    const now = Date.now();
    const activePauseMs =
      sessionStateRef.current === "paused" && sessionPausedAtRef.current
        ? now - sessionPausedAtRef.current
        : 0;
    return (
      now -
      sessionStartedAtRef.current -
      sessionPausedAccumMsRef.current -
      activePauseMs
    );
  }, []);

  const pauseSession = useCallback(() => {
    if (
      completionInProgressRef.current ||
      sessionStateRef.current !== "running"
    ) {
      return;
    }
    setSessionState("paused");
    sessionPausedAtRef.current = Date.now();
    setRecordingState(
      recordingStateRef.current === "recording"
        ? "paused"
        : recordingStateRef.current,
    );
    serviceRef.current?.pause();
  }, [setRecordingState, setSessionState]);

  const resumeSession = useCallback(() => {
    if (
      completionInProgressRef.current ||
      sessionStateRef.current !== "paused"
    ) {
      return;
    }
    const now = Date.now();
    if (sessionPausedAtRef.current) {
      sessionPausedAccumMsRef.current += now - sessionPausedAtRef.current;
      sessionPausedAtRef.current = 0;
    }
    setSessionState("running");
    setRecordingState(
      recordingStateRef.current === "paused"
        ? "recording"
        : recordingStateRef.current,
    );
    serviceRef.current?.resume();
  }, [setRecordingState, setSessionState]);

  const completeTestSession = useCallback(async () => {
    if (
      completionInProgressRef.current ||
      sessionStateRef.current === "completed" ||
      sessionStateRef.current === "completing"
    ) {
      return;
    }
    completionInProgressRef.current = true;
    setSessionState("completing");
    setRecordingState("stopping");
    if (serviceRef.current) {
      const stopResult = serviceRef.current.stop("user");
      void stopResult.catch(() => {
        setRecordingState(
          recordingStateRef.current === "stopped" ||
            recordingStateRef.current === "failed"
            ? recordingStateRef.current
            : "failed",
        );
      });
    }
    try {
      await trackTestEvent("test_completed");
    } finally {
      completionInProgressRef.current = false;
      setSessionState("completed");
      setRecordingState("stopped");
      resetSessionClock();
      setShowBanner(false);
      setPhase("idle");
      setMicIncluded(false);
      onEvent?.("stopped");
      serviceRef.current = null;
    }
  }, [onEvent, resetSessionClock, setRecordingState, setSessionState]);

  const handleStart = useCallback(async () => {
    if (!isScreenRecordingSupported()) {
      toast({
        title: "Screen recording isn't available",
        description: "Jack remains fully available without a recording.",
      });
      onEvent?.("unavailable");
      setSessionState("completed");
      setRecordingState("not_requested");
      setPhase("idle");
      return;
    }

    const session = getCachedTestSession();
    const currentSession =
      session ?? (await loadCurrentTestSession().catch(() => null));

    if (!currentSession || currentSession.status !== "active") {
      onEvent?.("unavailable");
      setSessionState("completed");
      setRecordingState("not_requested");
      setPhase("idle");
      return;
    }

    const includeMicrophone =
      currentSession.microphoneConsentState === "granted";
    const service = new RecordingService({
      onStop: (result) => void handleUpload(result),
      onPauseStateChange: (recordingPaused) => {
        if (
          sessionStateRef.current === "completed" ||
          sessionStateRef.current === "completing"
        ) {
          return;
        }
        setIsPaused(recordingPaused);
        setRecordingState(recordingPaused ? "paused" : "recording");
      },
      onError: () =>
        void trackTestEvent("reliability_error", {
          error_code: "recording_unavailable",
        }),
    });
    serviceRef.current = service;
    try {
      await service.start(includeMicrophone);
    } catch {
      serviceRef.current = null;
      onEvent?.("cancelled");
      setSessionState("completed");
      setRecordingState("not_requested");
      setPhase("idle");
      return;
    }
    sessionStartedAtRef.current = Date.now();
    sessionPausedAtRef.current = 0;
    sessionPausedAccumMsRef.current = 0;
    setSessionState("running");
    setRecordingState("recording");
    completionInProgressRef.current = false;
    void trackTestEvent("recording_started", {
      microphone_included: service.micIncluded,
    });
    onEvent?.("started");
    setMicIncluded(service.micIncluded);
    setShowBanner(true);
    setPhase("recording");
  }, [handleUpload, onEvent, setRecordingState, setSessionState, toast]);

  const handleCancelConsent = useCallback(() => {
    onEvent?.("declined");
    setSessionState("completed");
    setRecordingState("not_requested");
    setIsPaused(false);
    resetSessionClock();
    setPhase("idle");
  }, [onEvent, resetSessionClock, setRecordingState, setSessionState]);

  return (
    <>
      <UserTestingModal
        open={phase === "consent"}
        onStart={() => void handleStart()}
        onCancel={handleCancelConsent}
        cancelLabel="Continue Without Recording"
      />
      {phase === "recording" && serviceRef.current && (
        <RecordingIndicator
          getElapsedMs={() => getSessionElapsedMs()}
          isPaused={isPaused}
          onPause={pauseSession}
          onResume={resumeSession}
          onStop={() => void completeTestSession()}
          micIncluded={micIncluded}
        />
      )}
      {phase === "recording" && showBanner && (
        <ThinkAloudBanner onDismiss={() => setShowBanner(false)} />
      )}
    </>
  );
});
