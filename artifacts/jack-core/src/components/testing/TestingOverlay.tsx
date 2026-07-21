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

export type TestingOverlayEvent =
  | "consent_opened"
  | "started"
  | "declined"
  | "unavailable"
  | "cancelled"
  | "stopped";

interface TestingOverlayProps {
  /**
   * Opens the consent wall once per browser session on Jack entry. This still
   * never requests screen/mic permission until the tester clicks Start Test.
   */
  autoPrompt?: boolean;
  /** Emits state changes so the app shell can gate tester access. */
  onEvent?: (event: TestingOverlayEvent) => void;
}

const AUTO_PROMPT_SESSION_KEY = "jack.userTesting.promptSeen";

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
export const TestingOverlay = forwardRef<TestingOverlayHandle, TestingOverlayProps>(function TestingOverlay(
  { autoPrompt = false, onEvent },
  ref,
) {
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

  const open = useCallback(() => {
    setPhase((p) => {
      if (p !== "idle") return p;
      onEvent?.("consent_opened");
      return "consent";
    });
  }, [onEvent]);
  useImperativeHandle(ref, () => ({ open }), [open]);

  // `?test=true` auto-opens the consent modal ONLY — never auto-records.
  useEffect(() => {
    try {
      if (new URLSearchParams(window.location.search).get("test") === "true") {
        setPhase((p) => {
          if (p !== "idle") return p;
          onEvent?.("consent_opened");
          return "consent";
        });
      }
    } catch {
      /* malformed search string — ignore, app continues normally */
    }
  }, []);

  // For beta testers arriving directly at Jack from another domain, show the
  // consent wall before they start using the app. Dismissal is remembered for
  // this browser session only, so the prompt does not keep interrupting them.
  useEffect(() => {
    // Wait for server-resolved identity and never auto-enrol administrators.
    // Undefined means /me is still loading; false is the only tester-eligible state.
    if (!autoPrompt || me?.isAdmin !== false) return;

    try {
      if (new URLSearchParams(window.location.search).get("test") === "true") return;
      if (sessionStorage.getItem(AUTO_PROMPT_SESSION_KEY) === "true") return;
      setPhase((p) => {
        if (p !== "idle") return p;
        onEvent?.("consent_opened");
        return "consent";
      });
    } catch {
      setPhase((p) => {
        if (p !== "idle") return p;
        onEvent?.("consent_opened");
        return "consent";
      });
    }
  }, [autoPrompt, me?.isAdmin, onEvent]);

  const markAutoPromptSeen = useCallback(() => {
    try {
      sessionStorage.setItem(AUTO_PROMPT_SESSION_KEY, "true");
    } catch {
      /* sessionStorage unavailable — prompt behavior remains in-memory only */
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
      onEvent?.("stopped");
      setPhase("idle");
    },
    [me?.email, onEvent, toast],
  );

  const handleStart = useCallback(async () => {
    markAutoPromptSeen();

    if (!isScreenRecordingSupported()) {
      toast({
        title: "Screen recording isn't available",
        description: "This browser doesn't support screen recording, so this session won't be captured.",
      });
      onEvent?.("unavailable");
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
      onEvent?.("cancelled");
      setPhase("idle");
      return;
    }

    onEvent?.("started");
    setMicIncluded(service.micIncluded);
    setIsPaused(false);
    setShowBanner(true);
    setPhase("recording");
  }, [handleUpload, markAutoPromptSeen, onEvent, toast]);

  const handleCancelConsent = useCallback(() => {
    markAutoPromptSeen();
    onEvent?.("declined");
    setPhase("idle");
  }, [markAutoPromptSeen, onEvent]);

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
        cancelLabel="Continue Without Recording"
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
