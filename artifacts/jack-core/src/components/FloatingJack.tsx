import { useEffect, useRef, useState } from "react";
import { Loader2, Mic, Send, Volume2, X } from "lucide-react";
import { askJack, getMe } from "@workspace/api-client-react";
import {
  collectJackUiContext,
  encodeJackUiContextHeader,
  jackUiContextLabel,
  type JackUiContext,
} from "../lib/jack-ui-context";

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
    const refreshContext = () => {
      const next = collectJackUiContext();
      setUiContext((current) => (sameUiContext(current, next) ? current : next));
    };
    refreshContext();
    const interval = window.setInterval(refreshContext, 750);
    window.addEventListener("popstate", refreshContext);
    window.addEventListener("hashchange", refreshContext);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("popstate", refreshContext);
      window.removeEventListener("hashchange", refreshContext);
    };
  }, []);

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
      window.speechSynthesis?.cancel();
    };
  }, []);

  const speak = (text: string) => {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(plainSpeech(text));
    utterance.rate = 1;
    window.speechSynthesis.speak(utterance);
  };

  const submit = async (message: string) => {
    const trimmed = message.trim();
    if (!trimmed || pending) return;

    setPending(true);
    setError(null);
    setAnswer(null);
    setInput("");

    try {
      const context = collectJackUiContext();
      setUiContext(context);
      const response = await askJack(
        { message: trimmed },
        {
          credentials: "include",
          headers: {
            "X-Jack-Surface": context.surface,
            "X-Jack-Context": encodeJackUiContextHeader(context),
          },
        },
      );
      setAnswer(response.answer);
      speak(response.answer);
    } catch {
      setInput(trimmed);
      setError("Couldn’t reach Jack. Try that again.");
    } finally {
      setPending(false);
    }
  };

  const toggleListening = () => {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }

    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      setError("Voice input isn’t supported in this browser yet.");
      return;
    }

    const recognition = new Recognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-CA";
    recognition.onresult = (event) => {
      let transcript = "";
      let finalTranscript = "";
      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        transcript += result[0]?.transcript ?? "";
        if (result.isFinal) finalTranscript += result[0]?.transcript ?? "";
      }
      setInput(transcript.trim());
      if (finalTranscript.trim()) void submit(finalTranscript);
    };
    recognition.onerror = () => {
      setListening(false);
      setError("I didn’t catch that. Tap the mic and try again.");
    };
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    setError(null);
    setListening(true);
    recognition.start();
  };

  if (!authorized) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-[70] flex justify-center px-3">
      <div className="pointer-events-auto w-full max-w-2xl">
        {(answer || error) && (
          <div className="mb-2 rounded-2xl border border-border/80 bg-card/95 p-3 shadow-2xl backdrop-blur-xl">
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
                  window.speechSynthesis?.cancel();
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
          <div className="mb-1.5 px-4 font-mono text-[11px] text-muted-foreground">
            Jack is with you: {jackUiContextLabel(uiContext)}
          </div>
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
            {pending ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
          </button>
        </form>
      </div>
    </div>
  );
}
