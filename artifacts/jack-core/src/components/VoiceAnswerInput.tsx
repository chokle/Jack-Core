import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { Mic, Square, Loader2, Send, SkipForward, AlertCircle, Keyboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useAudioRecorder } from "@/hooks/use-audio-recorder";
import { transcribeInterviewAnswer } from "@/lib/transcribe-audio";

interface VoiceAnswerInputProps {
  sessionId: string;
  answer: string;
  onAnswerChange: Dispatch<SetStateAction<string>>;
  onSubmit: (e: React.FormEvent) => void;
  onSkip: () => void;
  onFinish: () => void;
  /** A parent mutation (submit/skip/finish) is in flight — locks the whole panel. */
  busy: boolean;
  /** The answer submission specifically is in flight. */
  submitting: boolean;
  /** Parent-level form error (e.g. "couldn't save that answer"). */
  formError: string | null;
  /** The "Park a thought" button, wired with interview context by the parent. */
  parkButton: React.ReactNode;
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Voice-first answer capture for Interview Mode. A big mic button records the
 * mentor's spoken answer, which is transcribed server-side (Whisper) into the
 * editable box below. The mentor reviews/edits, then Sends. Typing remains a
 * first-class fallback — the textarea is always available, and if the browser
 * can't record we degrade to typing only. Designed for retirees/field workers:
 * large, high-contrast controls and minimal required typing.
 */
export function VoiceAnswerInput({
  sessionId,
  answer,
  onAnswerChange,
  onSubmit,
  onSkip,
  onFinish,
  busy,
  submitting,
  formError,
  parkButton,
}: VoiceAnswerInputProps) {
  const recorder = useAudioRecorder();
  const [transcribing, setTranscribing] = useState(false);
  const [transcribeError, setTranscribeError] = useState<string | null>(null);

  const recording = recorder.state === "recording";
  const requesting = recorder.state === "requesting";
  const capturing = recording || requesting || transcribing;
  const hasText = answer.trim().length > 0;

  // A fresh question (parent clears the answer) resets any stale voice error.
  useEffect(() => {
    if (!answer) setTranscribeError(null);
  }, [answer]);

  const handleStart = () => {
    setTranscribeError(null);
    void recorder.start();
  };

  const handleStop = async () => {
    const rec = await recorder.stop();
    if (!rec || rec.durationMs < 400 || rec.blob.size < 1024) {
      setTranscribeError("That recording was too short — hold on, speak your answer, then stop.");
      return;
    }
    setTranscribeError(null);
    setTranscribing(true);
    try {
      const text = (await transcribeInterviewAnswer(sessionId, rec.blob, rec.mimeType)).trim();
      if (!text) {
        setTranscribeError("We couldn't make out any words — please try recording again.");
        return;
      }
      // Append so multiple takes accumulate; the mentor can edit freely below.
      onAnswerChange((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text));
    } catch (err) {
      setTranscribeError(
        err instanceof Error ? err.message : "Transcription failed — please try again.",
      );
    } finally {
      setTranscribing(false);
    }
  };

  const voiceError = recorder.error?.message ?? transcribeError;

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {/* Voice control zone — the primary way to answer */}
      {recorder.supported && (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-border bg-muted/20 px-4 py-6">
          {recording ? (
            <>
              <Button
                type="button"
                onClick={handleStop}
                className="h-16 w-full max-w-xs gap-3 rounded-xl bg-red-600 text-lg font-semibold text-white shadow-lg hover:bg-red-700"
              >
                <Square className="h-6 w-6 fill-current" /> Stop recording
              </Button>
              <div
                role="status"
                aria-live="polite"
                className="flex items-center gap-2 font-mono text-sm text-red-400"
              >
                <span className="h-3 w-3 animate-pulse rounded-full bg-red-500" />
                Recording… {formatElapsed(recorder.elapsedMs)}
              </div>
            </>
          ) : requesting ? (
            <Button
              type="button"
              disabled
              className="h-16 w-full max-w-xs gap-3 rounded-xl text-lg font-semibold"
            >
              <Loader2 className="h-6 w-6 animate-spin" /> Starting…
            </Button>
          ) : transcribing ? (
            <div
              role="status"
              aria-live="polite"
              className="flex h-16 items-center gap-3 text-lg font-medium text-primary"
            >
              <Loader2 className="h-6 w-6 animate-spin" /> Transcribing your answer…
            </div>
          ) : (
            <>
              <Button
                type="button"
                onClick={handleStart}
                disabled={busy}
                className="h-16 w-full max-w-xs gap-3 rounded-xl bg-primary text-lg font-semibold text-primary-foreground shadow-lg hover:bg-primary/90"
              >
                <Mic className="h-6 w-6" /> {hasText ? "Record again" : "Start recording"}
              </Button>
              <p className="text-center text-sm text-muted-foreground">
                Tap, speak your answer out loud, then tap stop.
              </p>
            </>
          )}
        </div>
      )}

      {/* Recording / transcription problems — always leaves typing available */}
      {voiceError && (
        <p className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{voiceError}</span>
        </p>
      )}

      {/* Editable transcript / typed answer */}
      <div className="space-y-1.5">
        <label
          htmlFor="interview-answer"
          className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground"
        >
          {recorder.supported ? (
            <>
              <Keyboard className="h-3.5 w-3.5" />
              Your answer — review and edit, or type here
            </>
          ) : (
            "Type your answer"
          )}
        </label>
        <Textarea
          id="interview-answer"
          value={answer}
          onChange={(e) => onAnswerChange(e.target.value)}
          placeholder={
            recorder.supported
              ? "Your spoken answer appears here — or just type. Jack captures it verbatim…"
              : "Answer in your own words — Jack captures it verbatim…"
          }
          className="min-h-32 resize-none bg-background text-base leading-relaxed"
          disabled={busy || capturing}
        />
      </div>

      {formError && (
        <p className="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 font-mono text-sm text-destructive">
          {formError}
        </p>
      )}

      {/* Actions */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={onSkip}
            disabled={busy || capturing}
            className="text-muted-foreground"
          >
            <SkipForward className="mr-2 h-4 w-4" /> Skip
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={onFinish}
            disabled={busy || capturing}
            className="text-muted-foreground"
          >
            Wrap up
          </Button>
          {parkButton}
        </div>
        <Button
          type="submit"
          disabled={busy || capturing || !hasText}
          className="h-14 gap-2 rounded-xl bg-primary px-8 text-lg font-semibold text-primary-foreground shadow-lg hover:bg-primary/90 sm:w-auto"
        >
          {submitting ? (
            <>
              <Loader2 className="h-5 w-5 animate-spin" /> Saving…
            </>
          ) : (
            <>
              <Send className="h-5 w-5" /> Send answer
            </>
          )}
        </Button>
      </div>
    </form>
  );
}
