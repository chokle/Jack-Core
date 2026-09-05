import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Mic, Send, Volume2, X } from "lucide-react";
import { askJack, getMe } from "@workspace/api-client-react";
import {
  collectJackUiContext,
  encodeJackUiContextHeader,
  jackUiContextLabel,
  type JackUiContext,
} from "../lib/jack-ui-context";
import {
  resolveJackLocalAction,
  resolveJackLocalCommand,
  unavailableJackLocalCommand,
} from "../lib/jack-local-command";
import {
  getJackVoiceHint,
  isJackVoiceHintMatch,
  isExplicitlyMasculineJackVoice,
  selectJackVoice,
} from "../lib/jack-speech";

const JACK_VOICE_DISCOVERY_GRACE_MS = 750;

interface SpeechRecognitionEventLike extends Event {
  results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }>;
}

interface SpeechRecognitionErrorEventLike extends Event {
  error?: string;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

function plainSpeech(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")
    .replace(/[*_>#-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sameUiContext(a: JackUiContext | null, b: JackUiContext) {
  if (!a) return false;
  return (
    a.route === b.route &&
    a.surface === b.surface &&
    a.path.join("|") === b.path.join("|") &&
    a.inspector.open === b.inspector.open &&
    a.inspector.label === b.inspector.label &&
    a.visibleIds.join("|") === b.visibleIds.join("|") &&
    a.navigation.canBack === b.navigation.canBack &&
    a.navigation.canUp === b.navigation.canUp &&
    a.navigation.canForward === b.navigation.canForward &&
    a.navigation.hasSourceAction === b.navigation.hasSourceAction
  );
}

export function FloatingJack() {
  const [authorized, setAuthorized] = useState(false);
  const [input, setInput] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [listening, setListening] = useState(false);
  const [uiContext, setUiContext] = useState<JackUiContext | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const submissionInFlightRef = useRef(false);
  const currentContextRef = useRef<JackUiContext | null>(null);
  const contextEpochRef = useRef(0);
  const requestRef = useRef<AbortController | null>(null);
  const pillRef = useRef<HTMLDivElement | null>(null);
  const speechRequestRef = useRef(0);
  const speechWaitCleanupRef = useRef<(() => void) | null>(null);

  const cancelSpeech = useCallback(() => {
    speechRequestRef.current += 1;
    speechWaitCleanupRef.current?.();
    speechWaitCleanupRef.current = null;
    window.speechSynthesis?.cancel();
  }, []);

  useEffect(() => {
    const pill = pillRef.current;
    if (!authorized || !pill) return;
    const reserveSpace = () =>
      document.documentElement.style.setProperty(
        "--jack-pill-height",
        `${Math.ceil(pill.getBoundingClientRect().height) + 12}px`,
      );
    reserveSpace();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(reserveSpace);
    observer?.observe(pill);
    return () => {
      observer?.disconnect();
      document.documentElement.style.removeProperty("--jack-pill-height");
    };
  }, [authorized, cancelSpeech]);

  const refreshContext = useCallback(() => {
    const next = collectJackUiContext();
    if (!sameUiContext(currentContextRef.current, next)) {
      const interruptedVoice = recognitionRef.current !== null;
      contextEpochRef.current += 1;
      requestRef.current?.abort();
      requestRef.current = null;
      submissionInFlightRef.current = false;
      recognitionRef.current?.abort();
      recognitionRef.current = null;
      cancelSpeech();
      setPending(false);
      setListening(false);
      setAnswer(null);
      setError(
        interruptedVoice ? "Page changed. Tap the mic to continue here." : null,
      );
      currentContextRef.current = next;
      setUiContext(next);
    }
    return next;
  }, [cancelSpeech]);

  useEffect(() => {
    let cancelled = false;

    const checkIdentity = async () => {
      try {
        await getMe({ credentials: "include" });
        if (!cancelled) setAuthorized(true);
      } catch {
        if (!cancelled) setAuthorized(false);
      }
    };

    const initial = window.setTimeout(checkIdentity, 500);
    const interval = window.setInterval(checkIdentity, 5000);
    return () => {
      cancelled = true;
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    refreshContext();
    const observer = new MutationObserver((mutations) => {
      if (
        mutations.some((mutation) => {
          const target =
            mutation.target instanceof Element
              ? mutation.target
              : mutation.target.parentElement;
          return !target?.closest("[data-floating-jack]");
        })
      )
        refreshContext();
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    window.addEventListener("popstate", refreshContext);
    window.addEventListener("hashchange", refreshContext);
    window.addEventListener("resize", refreshContext);
    window.addEventListener("animationend", refreshContext);
    window.addEventListener("transitionend", refreshContext);
    return () => {
      observer.disconnect();
      window.removeEventListener("popstate", refreshContext);
      window.removeEventListener("hashchange", refreshContext);
      window.removeEventListener("resize", refreshContext);
      window.removeEventListener("animationend", refreshContext);
      window.removeEventListener("transitionend", refreshContext);
    };
  }, [refreshContext]);

  useEffect(() => {
    if (!authorized) {
      contextEpochRef.current += 1;
      requestRef.current?.abort();
      requestRef.current = null;
      submissionInFlightRef.current = false;
      recognitionRef.current?.abort();
      recognitionRef.current = null;
      cancelSpeech();
      setAnswer(null);
      setError(null);
      setInput("");
      setPending(false);
      setListening(false);
    }
  }, [authorized, cancelSpeech]);

  useEffect(() => {
    return () => {
      contextEpochRef.current += 1;
      requestRef.current?.abort();
      recognitionRef.current?.abort();
      cancelSpeech();
    };
  }, [cancelSpeech]);

  const speak = (text: string) => {
    const synthesis = window.speechSynthesis;
    if (!synthesis || typeof SpeechSynthesisUtterance === "undefined") return;

    speechRequestRef.current += 1;
    const request = speechRequestRef.current;
    speechWaitCleanupRef.current?.();
    speechWaitCleanupRef.current = null;
    synthesis.cancel();
    const voiceHint = getJackVoiceHint();

    const speakNow = () => {
      if (speechRequestRef.current !== request) return;
      speechWaitCleanupRef.current = null;
      const utterance = new SpeechSynthesisUtterance(plainSpeech(text));
      const voices =
        typeof synthesis.getVoices === "function" ? synthesis.getVoices() : [];
      const voice = selectJackVoice(
        voices,
        navigator.language || "en-US",
        voiceHint,
      );
      if (voice) utterance.voice = voice;
      // Android Chrome exposes locale voices without gender metadata. Use a
      // materially lower pitch in that case; a mild 0.88 adjustment still
      // sounded like the device's default feminine voice on Pixel hardware.
      utterance.rate = 0.96;
      utterance.pitch = isExplicitlyMasculineJackVoice(voice) ? 0.92 : 0.64;
      synthesis.speak(utterance);
    };

    const readVoices = () =>
      typeof synthesis.getVoices === "function"
        ? synthesis.getVoices()
        : ([] as SpeechSynthesisVoice[]);
    const voices = readVoices();
    const isPreferredVoice = (voice: SpeechSynthesisVoice) =>
      isExplicitlyMasculineJackVoice(voice) ||
      isJackVoiceHintMatch(voice, voiceHint);
    const hasPreferredVoice = voices.some(isPreferredVoice);
    if (
      hasPreferredVoice ||
      typeof synthesis.addEventListener !== "function" ||
      typeof synthesis.getVoices !== "function"
    ) {
      speakNow();
      return;
    }

    let timeoutId: number | undefined;
    const onVoicesChanged = () => {
      if (readVoices().some(isPreferredVoice)) {
        cleanupWait();
        speakNow();
      }
    };
    const cleanupWait = () => {
      synthesis.removeEventListener?.("voiceschanged", onVoicesChanged);
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      if (speechWaitCleanupRef.current === cleanupWait)
        speechWaitCleanupRef.current = null;
    };
    speechWaitCleanupRef.current = cleanupWait;
    synthesis.addEventListener("voiceschanged", onVoicesChanged);
    timeoutId = window.setTimeout(() => {
      cleanupWait();
      speakNow();
    }, JACK_VOICE_DISCOVERY_GRACE_MS);
  };

  const submit = async (message: string) => {
    const trimmed = message.trim();
    if (!authorized || !trimmed || submissionInFlightRef.current) return;

    const context = refreshContext();
    const epoch = contextEpochRef.current;
    const controller = new AbortController();
    requestRef.current = controller;

    submissionInFlightRef.current = true;
    setPending(true);
    setError(null);
    setAnswer(null);
    setInput("");
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    recognition?.abort();
    setListening(false);
    cancelSpeech();

    try {
      const localCommand = resolveJackLocalCommand(trimmed);
      if (localCommand) {
        const action = resolveJackLocalAction(localCommand);
        if (action) {
          action.click();
          // React may commit a shell/graph navigation after the click returns.
          // Refresh once on the next task as well as through the DOM observer so
          // the pill never keeps the pre-navigation surface as stale context.
          window.setTimeout(refreshContext, 0);
          return;
        }
        const localAnswer = unavailableJackLocalCommand(localCommand);
        setAnswer(localAnswer);
        speak(localAnswer);
        return;
      }
      const response = await askJack(
        { message: trimmed },
        {
          credentials: "include",
          signal: controller.signal,
          headers: {
            "X-Jack-Surface": encodeURIComponent(context.surface),
            "X-Jack-Context": encodeJackUiContextHeader(context),
          },
        },
      );
      refreshContext();
      if (controller.signal.aborted || contextEpochRef.current !== epoch)
        return;
      setAnswer(response.answer);
      speak(response.answer);
    } catch {
      refreshContext();
      if (controller.signal.aborted || contextEpochRef.current !== epoch)
        return;
      setInput(trimmed);
      setError("Couldn’t reach Jack. Try that again.");
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        submissionInFlightRef.current = false;
        setPending(false);
      }
    }
  };

  const toggleListening = () => {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }

    const Recognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      setError("Voice input isn’t supported in this browser yet.");
      return;
    }

    const recognition = new Recognition();
    refreshContext();
    const epoch = contextEpochRef.current;
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-CA";
    recognition.onresult = (event) => {
      refreshContext();
      if (
        recognitionRef.current !== recognition ||
        contextEpochRef.current !== epoch
      )
        return;
      let transcript = "";
      let finalTranscript = "";
      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        transcript += result[0]?.transcript ?? "";
        if (result.isFinal) finalTranscript += result[0]?.transcript ?? "";
      }
      setInput(transcript.trim());
      if (finalTranscript.trim()) {
        recognition.onresult = null;
        recognition.stop();
        setListening(false);
        void submit(finalTranscript);
      }
    };
    recognition.onerror = () => {
      if (recognitionRef.current !== recognition) return;
      recognitionRef.current = null;
      setListening(false);
      setError("I didn’t catch that. Tap the mic and try again.");
    };
    recognition.onend = () => {
      if (recognitionRef.current === recognition) {
        recognitionRef.current = null;
        setListening(false);
      }
    };
    recognitionRef.current = recognition;
    setError(null);
    setListening(true);
    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      setListening(false);
      setError(
        "Couldn’t start the microphone. Check microphone access and try again.",
      );
    }
  };

  if (!authorized) return null;

  return (
    <div
      ref={pillRef}
      data-floating-jack
      className="pointer-events-none fixed inset-x-0 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-[70] flex justify-center px-3"
    >
      <div className="pointer-events-auto w-full max-w-2xl">
        {(answer || error) && (
          <div className="mb-2 max-h-[min(40dvh,18rem)] overflow-y-auto rounded-2xl border border-border/80 bg-card/95 p-3 shadow-2xl backdrop-blur-xl">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1 text-sm leading-relaxed text-foreground">
                {answer || error}
              </div>
              {answer && (
                <button
                  type="button"
                  onClick={() => speak(answer)}
                  className="rounded-full p-2 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                  aria-label="Read Jack's answer aloud"
                >
                  <Volume2 className="h-4 w-4" />
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setAnswer(null);
                  setError(null);
                  cancelSpeech();
                }}
                className="rounded-full p-2 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                aria-label="Dismiss Jack's answer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}

        {uiContext && (
          <details className="mb-1.5 rounded-xl bg-card/95 px-4 py-1 text-xs text-muted-foreground">
            <summary
              title={jackUiContextLabel(uiContext)}
              className="cursor-pointer truncate font-mono text-[11px]"
            >
              Jack is with you: {jackUiContextLabel(uiContext)}
            </summary>
            <div className="max-h-[25dvh] overflow-y-auto py-2">
              <p className="mb-2">
                Jack follows your activity inside Jack only.
              </p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 break-words">
                <dt>Page</dt>
                <dd>{uiContext.route}</dd>
                <dt>Surface</dt>
                <dd>{uiContext.surface}</dd>
                <dt>Path</dt>
                <dd>{jackUiContextLabel(uiContext)}</dd>
                <dt>Inspector</dt>
                <dd>
                  {uiContext.inspector.open
                    ? uiContext.inspector.label || "Open"
                    : "Closed"}
                </dd>
                <dt>Visible records</dt>
                <dd>{uiContext.visibleIds.join(", ") || "None"}</dd>
                <dt>Navigation</dt>
                <dd>
                  {[
                    uiContext.navigation.canBack && "Back",
                    uiContext.navigation.canUp && "Up",
                    uiContext.navigation.canForward && "Forward",
                    uiContext.navigation.hasSourceAction && "Source",
                  ]
                    .filter(Boolean)
                    .join(", ") || "None"}
                </dd>
              </dl>
            </div>
          </details>
        )}

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit(input);
          }}
          className="flex items-center gap-1.5 rounded-full border border-border/80 bg-card/95 p-1.5 pl-4 shadow-2xl backdrop-blur-xl"
        >
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder={listening ? "Listening…" : "Ask Jack anything…"}
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            aria-label="Ask Jack"
          />
          <button
            type="button"
            onClick={toggleListening}
            className={`rounded-full p-2.5 transition ${
              listening
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
            aria-label={listening ? "Stop listening" : "Talk to Jack"}
          >
            <Mic className="h-5 w-5" />
          </button>
          <button
            type="submit"
            disabled={!input.trim() || pending}
            className="rounded-full bg-primary p-2.5 text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Send to Jack"
          >
            {pending ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <Send className="h-5 w-5" />
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
