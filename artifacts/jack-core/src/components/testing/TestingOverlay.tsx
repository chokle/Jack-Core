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

  const open = useCallback(() => {
    setPhase((current) => {
      if (current !== "idle") return current;
      onEvent?.("consent_opened");
      return "consent";
    });
  }, [onEvent]);
  useImperativeHandle(ref, () => ({ open }), [open]);

  useEffect(() => {
    const withdraw = (event: Event) => {
      const withdrawn = (event as CustomEvent<{ withdrawn?: unknown }>).detail
        ?.withdrawn;
      if (
        Array.isArray(withdrawn) &&
        !withdrawn.some((scope) =>
          ["telemetry", "screen", "microphone"].includes(String(scope)),
        )
      ) {
        return;
      }
      serviceRef.current?.cancel();
      serviceRef.current = null;
      setShowBanner(false);
      setPhase("idle");
    };
    window.addEventListener("jack:telemetry-withdrawn", withdraw);
    return () =>
      window.removeEventListener("jack:telemetry-withdrawn", withdraw);
  }, []);

  const handleUpload = useCallback(
    async (result: TestRecordingResult) => {
      const session = getCachedTestSession();
      if (!session) {
        setPhase("idle");
        return;
      }
      setPhase("uploading");
      setShowBanner(false);
      void trackTestEvent("recording_stopped", {
        stop_reason:
          result.stopReason === "native-stop-sharing"
            ? "native_stop_sharing"
            : result.stopReason,
      });
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
      serviceRef.current = null;
      onEvent?.("stopped");
      setPhase("idle");
    },
    [onEvent, toast],
  );

  const handleStart = useCallback(async () => {
    if (!isScreenRecordingSupported()) {
      toast({
        title: "Screen recording isn't available",
        description: "Jack remains fully available without a recording.",
      });
      onEvent?.("unavailable");
      setPhase("idle");
      return;
    }

    const session = getCachedTestSession();
    const currentSession =
      session ?? (await loadCurrentTestSession().catch(() => null));

    if (!currentSession || currentSession.status !== "active") {
      onEvent?.("unavailable");
      setPhase("idle");
      return;
    }

    const includeMicrophone =
      currentSession.microphoneConsentState === "granted";
    const service = new RecordingService({
      onStop: (result) => void handleUpload(result),
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
      setPhase("idle");
      return;
    }
    if (serviceRef.current !== service) {
      service.cancel();
      return;
    }
    void trackTestEvent("recording_started", {
      microphone_included: service.micIncluded,
    });
    onEvent?.("started");
    setMicIncluded(service.micIncluded);
    setIsPaused(false);
    setShowBanner(true);
    setPhase("recording");
  }, [handleUpload, onEvent, toast]);

  const handleCancelConsent = useCallback(() => {
    onEvent?.("declined");
    setPhase("idle");
  }, [onEvent]);

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
          getElapsedMs={() => serviceRef.current?.elapsedMs() ?? 0}
          isPaused={isPaused}
          onPause={() => {
            serviceRef.current?.pause();
            setIsPaused(true);
          }}
          onResume={() => {
            serviceRef.current?.resume();
            setIsPaused(false);
          }}
          onStop={() => void serviceRef.current?.stop("user")}
          micIncluded={micIncluded}
        />
      )}
      {phase === "recording" && showBanner && (
        <ThinkAloudBanner onDismiss={() => setShowBanner(false)} />
      )}
    </>
  );
});
