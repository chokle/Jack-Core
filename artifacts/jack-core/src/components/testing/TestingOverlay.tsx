import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useGetMe } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import {
  RecordingService,
  isScreenRecordingSupported,
  type TestRecordingResult,
} from "@/lib/user-testing/recording-service";
import { uploadTestRecording } from "@/lib/user-testing/upload-service";
import { UserTestingModal } from "./UserTestingModal";
import { RecordingIndicator } from "./RecordingIndicator";
import { ThinkAloudBanner } from "./ThinkAloudBanner";

type Phase = "idle" | "consent" | "recording" | "uploading";

export interface TestingOverlayHandle {
  /** Open the consent modal (never starts recording directly). */
  open: () => void;
}

/**
 * Beta user-testing orchestrator — mount once near the root of the
 * authenticated app. Owns the whole idle -> consent -> recording -> uploading
 * state machine and renders the consent modal, the floating recording
 * indicator, and the think-aloud banner. Exposes no required props: the
 * trigger is either `?test=true` on load (opens the consent modal only — see
 * SAFETY note in recording-service.ts) or an external caller invoking the
 * imperative handle via a forwarded ref (e.g. a "Start User Test" button
 * elsewhere in the shell).
 */
export const TestingOverlay = forwardRef<TestingOverlayHandle>(function TestingOverlay(_props, ref) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [isPaused, setIsPaused] = useState(false);
  const [micIncluded, setMicIncluded] = useState(true);
  const [showBanner, setShowBanner] = useState(false);
  const serviceRef = useRef<RecordingService | null>(null);
  const sessionIdRef = useRef<string>("");
  const { toast } = useToast();
  // Best-effort tester identity for local pending-upload bookkeeping only —
  // the server independently resolves the authenticated identity for the
  // stored row, never trusting a client-supplied value (see threat_model.md).
  const { data: me } = useGetMe();

  const open = useCallback(() => setPhase((p) => (p === "idle" ? "consent" : p)), []);
  useImperativeHandle(ref, () => ({ open }), [open]);

  // `?test=true` auto-opens the consent modal ONLY — never auto-records.
  useEffect(() => {
    try {
      if (new URLSearchParams(window.location.search).get("test") === "true") {
        setPhase((p) => (p === "idle" ? "consent" : p));
      }
    } catch {
      /* malformed search string — ignore, app continues normally */
    }
  }, []);

  const handleUpload = useCallback(
    async (result: TestRecordingResult) => {
      setPhase("uploading");
      setShowBanner(false);
      const outcome = await uploadTestRecording(result.blob, {
        sessionId: sessionIdRef.current,
        timestamp: new Date().toISOString(),
        userAgent: navigator.userAgent,
        screenResolution: result.screenResolution,
        durationMs: result.durationMs,
        mimeType: result.mimeType,
        appVersion: import.meta.env.VITE_APP_VERSION,
        testerId: me?.email ?? undefined,
      });

      if (outcome.status === "uploaded") {
        toast({
          title: "Test recording uploaded",
          description: "Thanks for helping us improve Torch!",
        });
      } else {
        toast({
          title: "Saved recording to your downloads",
          description: `We couldn't reach the upload server, so "${outcome.filename}" was downloaded instead. Please share it with the team.`,
        });
      }
      setPhase("idle");
    },
    [me?.email, toast],
  );

  const handleStart = useCallback(async () => {
    if (!isScreenRecordingSupported()) {
      toast({
        title: "Screen recording isn't available",
        description: "This browser doesn't support screen recording, so this session won't be captured.",
      });
      setPhase("idle");
      return;
    }

    sessionIdRef.current = crypto.randomUUID();
    const service = new RecordingService({
      onStop: (result) => void handleUpload(result),
      onError: (err) => toast({ title: "Recording error", description: err.message }),
    });
    serviceRef.current = service;

    try {
      await service.start();
    } catch {
      // Permission denied or the browser's share picker was cancelled — never
      // block the app, just fall back to normal use.
      toast({
        title: "Recording cancelled",
        description: "No screen permission was granted, so nothing was recorded.",
      });
      serviceRef.current = null;
      setPhase("idle");
      return;
    }

    setMicIncluded(service.micIncluded);
    setIsPaused(false);
    setShowBanner(true);
    setPhase("recording");
  }, [handleUpload, toast]);

  const handleCancelConsent = useCallback(() => setPhase("idle"), []);

  const handleStop = useCallback(() => {
    void serviceRef.current?.stop("user");
  }, []);

  const handlePause = useCallback(() => {
    serviceRef.current?.pause();
    setIsPaused(true);
  }, []);

  const handleResume = useCallback(() => {
    serviceRef.current?.resume();
    setIsPaused(false);
  }, []);

  return (
    <>
      <UserTestingModal
        open={phase === "consent"}
        onStart={() => void handleStart()}
        onCancel={handleCancelConsent}
      />
      {phase === "recording" && serviceRef.current && (
        <RecordingIndicator
          getElapsedMs={() => serviceRef.current?.elapsedMs() ?? 0}
          isPaused={isPaused}
          onPause={handlePause}
          onResume={handleResume}
          onStop={handleStop}
          micIncluded={micIncluded}
        />
      )}
      {phase === "recording" && showBanner && (
        <ThinkAloudBanner onDismiss={() => setShowBanner(false)} />
      )}
    </>
  );
});
