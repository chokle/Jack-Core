import { useState, useRef, useEffect, useCallback } from "react";
import {
  ChevronDown,
  Send,
  Bot,
  User,
  X,
  Loader2,
  Sparkles,
  Bookmark,
  RotateCcw,
  Pause,
  Volume2,
  VolumeX,
  Play,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  useAskJack,
  useGetChatHistory,
  useClearChatHistory,
  getGetChatHistoryQueryKey,
  ChatMessage,
  type Citation,
  type ParkedThought,
} from "@workspace/api-client-react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { StructuredAnswer } from "@/components/StructuredAnswer";
import { ParkThisThoughtButton } from "@/components/ParkedThoughts";
import { timeAgo } from "@/lib/memory-graph";
import { getCachedTestSession } from "@/lib/user-testing/test-session-service";

type DisplayMessage = ChatMessage & { usedInternalKnowledge?: boolean };
const STORAGE_VOICE_ENABLED_KEY = "jack.ask-jack.voice-enabled";
const STORAGE_VOICE_VOLUME_KEY = "jack.ask-jack.voice-volume";
const STORAGE_VOICE_PAUSED_KEY = "jack.ask-jack.voice-paused";

function clampVolume(value: number): number {
  return Math.min(1, Math.max(0, value));
}

// Chat history is scoped server-side to the signed-in Clerk account (derived
// from the auth session on every /api request), so it follows the user across
// devices and never leaks to another user on the same device. The client does
// not read, store, or transmit any session/user identifier — auth credentials
// ride along automatically on same-origin requests.

interface AskJackProps {
  isOpen: boolean;
  onClose: () => void;
  initialContext?: string;
  selectedVideoId?: string | null;
  onCitationClick: (
    citationIndex: number,
    videoId: string,
    startTime: number,
    sourceType: "video" | "knowledge",
  ) => void;
  onFieldNoteClick: (citation: Citation) => void;
  /** Set when the drawer was opened via "Resume" on a parked thought. */
  resumedThought?: ParkedThought;
  onMeaningfulSessionComplete?: () => void;
}

export function AskJack({
  isOpen,
  onClose,
  initialContext,
  selectedVideoId,
  onCitationClick,
  onFieldNoteClick,
  resumedThought,
  onMeaningfulSessionComplete,
}: AskJackProps) {
  const [input, setInput] = useState(initialContext || "");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const prefersReducedMotion = useReducedMotion();

  // No sessionId parameter — the server resolves the session from the cookie.
  const { data: history } = useGetChatHistory();
  const telemetrySession = getCachedTestSession();
  const askJack = useAskJack(
    telemetrySession
      ? {
          request: {
            headers: { "X-Jack-Test-Session-Id": telemetrySession.id },
          },
        }
      : undefined,
  );
  const queryClient = useQueryClient();
  const clearHistory = useClearChatHistory();
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const shouldReturnFocusToInputRef = useRef(false);
  const submittedMessageRef = useRef("");
  const activeRequestIdRef = useRef(0);
  const steerChoiceInputRef = useRef("");
  const queueFocusIntentRef = useRef(false);
  const queuedMessageRef = useRef<string | null>(null);
  const [queuedMessage, setQueuedMessage] = useState<string | null>(null);
  const [steerChoiceMessage, setSteerChoiceMessage] = useState<string | null>(
    null,
  );

  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [successfulTurns, setSuccessfulTurns] = useState(0);
  const [speechEnabled, setSpeechEnabled] = useState(true);
  const [speechPaused, setSpeechPaused] = useState(false);
  const [speechVolume, setSpeechVolume] = useState(0.9);
  const speechSupported = typeof window !== "undefined" && "speechSynthesis" in window;
  const speechUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const stopSpeech = useCallback(() => {
    if (!speechSupported) return;
    window.speechSynthesis.cancel();
    speechUtteranceRef.current = null;
  }, [speechSupported]);

  function formatMessageTime(createdAt?: string): string | null {
    if (!createdAt) return null;
    const date = new Date(createdAt);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
  }

  const close = () => {
    if (successfulTurns > 0) onMeaningfulSessionComplete?.();
    setSuccessfulTurns(0);
    stopSpeech();
    onClose();
  };

  const persistVoiceSettings = (enabled: boolean, paused: boolean, volume: number) => {
    if (!speechSupported) return;
    try {
      window.localStorage.setItem(STORAGE_VOICE_ENABLED_KEY, String(enabled));
      window.localStorage.setItem(STORAGE_VOICE_PAUSED_KEY, String(paused));
      window.localStorage.setItem(STORAGE_VOICE_VOLUME_KEY, String(volume));
    } catch {
      return;
    }
  };

  const speakAnswer = useCallback(
    (text: string) => {
      if (
        !speechEnabled ||
        speechPaused ||
        !speechSupported ||
        !text.trim()
      ) {
        return;
      }
      stopSpeech();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.volume = speechVolume;
      utterance.lang = "en-US";
      speechUtteranceRef.current = utterance;
      window.speechSynthesis.speak(utterance);
    },
    [speechEnabled, speechPaused, speechSupported, speechVolume, stopSpeech],
  );

  const handleSetSpeechEnabled = (nextEnabled: boolean) => {
    setSpeechEnabled(nextEnabled);
    if (!nextEnabled) {
      stopSpeech();
    }
    persistVoiceSettings(nextEnabled, speechPaused, speechVolume);
  };

  const handleToggleSpeechPause = () => {
    setSpeechPaused((prev) => {
      const next = !prev;
      if (next) {
        stopSpeech();
      }
      persistVoiceSettings(speechEnabled, next, speechVolume);
      return next;
    });
  };

  const handleSetSpeechVolume = (nextVolume: number) => {
    const normalized = clampVolume(nextVolume);
    setSpeechVolume(normalized);
    persistVoiceSettings(speechEnabled, speechPaused, normalized);
  };

  const increaseSpeechVolumeByTenPercent = () => {
    handleSetSpeechVolume(Math.round((speechVolume + 0.1) * 10) / 10);
  };

  const handleClearConversation = () => {
    clearHistory.mutate(undefined, {
      onSuccess: () => {
        setMessages([]);
        // Prevent the just-cleared history refetch from repopulating messages
        // via the restore effect above.
        queryClient.setQueryData(getGetChatHistoryQueryKey(), []);
        setConfirmingClear(false);
      },
    });
  };

  useEffect(() => {
    setBannerDismissed(false);
  }, [resumedThought?.id]);

  useEffect(() => {
    if (history && history.length > 0 && messages.length === 0) {
      setMessages(history);
    }
  }, [history]);

  useEffect(() => {
    if (!speechSupported) return;
    try {
      const rawEnabled = window.localStorage.getItem(STORAGE_VOICE_ENABLED_KEY);
      const rawPaused = window.localStorage.getItem(STORAGE_VOICE_PAUSED_KEY);
      const rawVolume = window.localStorage.getItem(STORAGE_VOICE_VOLUME_KEY);

      if (rawEnabled !== null) {
        setSpeechEnabled(rawEnabled === "true");
      }
      if (rawPaused !== null) {
        setSpeechPaused(rawPaused === "true");
      }
      if (rawVolume !== null) {
        const parsed = Number(rawVolume);
        if (Number.isFinite(parsed)) {
          setSpeechVolume(clampVolume(parsed));
        }
      }
    } catch {
      return;
    }
  }, [speechSupported]);

  useEffect(() => {
    if (initialContext) {
      setInput(initialContext);
    }
  }, [initialContext]);

  useEffect(() => {
    if (!isOpen) return undefined;
    // Focus as soon as the drawer opens so automation (and keyboard users)
    // don't have to wait for/race the entrance animation.
    const id = window.setTimeout(() => {
      const activeElement = document.activeElement;
      if (
        activeElement == null ||
        activeElement === document.body ||
        activeElement === document.documentElement
      ) {
        inputRef.current?.focus();
      }
    }, 0);
    return () => window.clearTimeout(id);
  }, [isOpen]);

  useEffect(() => {
    const viewport = scrollRef.current?.querySelector<HTMLElement>(
      "[data-radix-scroll-area-viewport]",
    );
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [messages]);

  useEffect(() => {
    persistVoiceSettings(speechEnabled, speechPaused, speechVolume);
  }, [speechEnabled, speechPaused, speechVolume]);

  useEffect(() => {
    return () => {
      stopSpeech();
    };
  }, [stopSpeech]);

  function requestInputFocusAfterResponse() {
    if (!shouldReturnFocusToInputRef.current) return;
    shouldReturnFocusToInputRef.current = false;
    window.setTimeout(() => {
      inputRef.current?.focus();
    }, 0);
  }

  function getLoadingCopy(): string {
    return "Lemme think for a sec...";
  }

  const setQueuedMessageWithRef = (message: string | null) => {
    queuedMessageRef.current = message;
    setQueuedMessage(message);
  };

  const clearQueuedMessage = () => {
    setQueuedMessageWithRef(null);
    queueFocusIntentRef.current = false;
  };

  const updateQueuedMessageDraft = (next: string) => {
    if (queuedMessageRef.current !== null) {
      setQueuedMessageWithRef(next);
    }
  };

  const onInputChange = (nextValue: string) => {
    setInput(nextValue);
    if (steerChoiceMessage) {
      steerChoiceInputRef.current = nextValue;
      setSteerChoiceMessage(nextValue);
    }
    if (queuedMessageRef.current !== null) {
      updateQueuedMessageDraft(nextValue);
    }
  };

  const submitChatTurn = (message: string, shouldRestoreFocus: boolean) => {
    const userMessage: ChatMessage = {
      id: `${Date.now()}-${++activeRequestIdRef.current}`,
      role: "user",
      content: message,
      createdAt: new Date().toISOString(),
    };

    shouldReturnFocusToInputRef.current = shouldRestoreFocus;
    setErrorMessage(null);
    submittedMessageRef.current = message;

    const requestId = activeRequestIdRef.current;
    setMessages((prev) => [...prev, userMessage]);
    setInput("");

    askJack.mutate(
      {
        data: {
          message: userMessage.content,
          ...(selectedVideoId ? { selectedVideoId } : {}),
        },
      },
      {
        onSuccess: (data) => {
          if (requestId !== activeRequestIdRef.current) return;

          const assistantMessage: DisplayMessage = {
            id: `${requestId}-${Date.now()}`,
            role: "assistant",
            content: data.answer,
            citations: data.citations,
            usedInternalKnowledge: data.usedInternalKnowledge,
            createdAt: new Date().toISOString(),
          };
          setMessages((prev) => [...prev, assistantMessage]);
          speakAnswer(data.answer);
          setSuccessfulTurns((count) => count + 1);
          setErrorMessage(null);
          requestInputFocusAfterResponse();

          if (queuedMessageRef.current !== null) {
            const nextMessage = queuedMessageRef.current;
            const nextFocusIntent = queueFocusIntentRef.current;
            clearQueuedMessage();
            submitChatTurn(nextMessage, nextFocusIntent);
          }
        },
        onError: (error: unknown) => {
          if (requestId !== activeRequestIdRef.current) return;

          const waitingMessage = queuedMessageRef.current;
          setMessages((prev) => prev.slice(0, -1));

          setInput((currentInput) => {
            if (currentInput.trim()) return currentInput;
            if (waitingMessage) return waitingMessage;
            return submittedMessageRef.current;
          });

          if (waitingMessage) {
            clearQueuedMessage();
          }

          setErrorMessage(formatAskJackError(error));
          requestInputFocusAfterResponse();
        },
      },
    );
  };

  const openSteerChoice = (message: string) => {
    if (steerChoiceMessage) return;
    steerChoiceInputRef.current = message.trim();
    setSteerChoiceMessage(message.trim());
  };

  const closeSteerChoice = () => {
    steerChoiceInputRef.current = "";
    setSteerChoiceMessage(null);
  };

  const handleWait = () => {
    const draft = steerChoiceMessage || steerChoiceInputRef.current;
    if (!draft) return;

    closeSteerChoice();
    setQueuedMessageWithRef(draft);
    queueFocusIntentRef.current = document.activeElement === inputRef.current;
    setInput("");
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;

    if (askJack.isPending) {
      openSteerChoice(input);
      return;
    }

    if (queuedMessage !== null) {
      setQueuedMessageWithRef(null);
    }

    submitChatTurn(input, document.activeElement === inputRef.current);
  };

  function formatAskJackError(error: unknown): string {
    if (error == null) {
      return "I couldn’t send that right now. Please try again.";
    }
    const err = error as {
      status?: number;
      message?: string;
      response?: { status?: number; data?: { error?: string } };
    };
    const status = err.response?.status ?? err.status;
    const serverMessage = err.response?.data?.error;
    if (typeof serverMessage === "string" && serverMessage.trim()) {
      return serverMessage;
    }
    if (typeof status === "number" && status >= 400) {
      if (status === 401 || status === 403) {
        return "Your session is no longer active. Please sign in and try again.";
      }
      return "Ask Jack is temporarily unavailable. Please try again in a moment.";
    }
    if (typeof err.message === "string" && err.message.trim()) {
      return err.message;
    }
    return "I couldn’t send that right now. Please try again.";
  }

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ x: "100%", opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: "100%", opacity: 0 }}
          transition={
            prefersReducedMotion
              ? { duration: 0 }
              : { type: "spring", damping: 30, stiffness: 320 }
          }
          className="fixed top-0 right-0 h-dvh w-full sm:w-[450px] bg-sidebar border-l border-sidebar-border shadow-2xl flex flex-col z-50"
        >
          <div className="flex items-center justify-between p-4 border-b border-sidebar-border bg-sidebar-primary/5">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded bg-primary flex items-center justify-center text-primary-foreground shadow-[0_0_10px_rgba(255,100,0,0.5)]">
                <Bot className="h-5 w-5" />
              </div>
              <div>
                <h2 className="font-semibold tracking-tight text-sidebar-foreground">
                  Ask Jack
                </h2>
                <p className="text-[10px] font-mono text-sidebar-foreground/60 uppercase">
                  Intelligence Engine
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                onClick={onClose}
                title="Minimize Ask Jack"
                aria-label="Minimize Ask Jack"
              >
                <ChevronDown className="h-4 w-4" />
              </Button>
              {messages.length > 0 && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setConfirmingClear(true)}
                  title="Start a new conversation"
                  aria-label="Start a new conversation"
                >
                  <RotateCcw className="h-4 w-4" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                onClick={close}
                aria-label="Close Ask Jack"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {resumedThought && !bannerDismissed && (
            <div className="flex items-start justify-between gap-2 border-b border-amber-400/30 bg-amber-400/10 px-4 py-2.5">
              <div className="flex items-start gap-2">
                <Bookmark className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
                <p className="text-xs leading-relaxed text-amber-200/90">
                  Picking up where you left off — parked{" "}
                  {timeAgo(resumedThought.createdAt)}
                  {resumedThought.reason ? `: "${resumedThought.reason}"` : "."}
                </p>
              </div>
              <button
                onClick={() => setBannerDismissed(true)}
                aria-label="Dismiss"
                className="shrink-0 text-amber-300/70 hover:text-amber-200"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          <ScrollArea className="flex-1 p-4" ref={scrollRef}>
            <div className="space-y-6 pb-4">
              {messages.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-[50vh] text-center space-y-4 opacity-50">
                  <Sparkles className="h-12 w-12 text-primary" />
                  <p className="text-sm font-mono max-w-[250px]">
                    I have indexed the entire trade knowledge base. Ask me
                    anything.
                  </p>
                </div>
              ) : (
                messages.map((msg) => {
                  const messageTime = formatMessageTime(msg.createdAt);
                  return (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      key={msg.id}
                      className={`flex gap-3 ${msg.role === "user" ? "flex-row-reverse" : ""}`}
                    >
                      <div
                        className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${msg.role === "user" ? "bg-secondary" : "bg-primary text-primary-foreground"}`}
                      >
                        {msg.role === "user" ? (
                          <User className="h-4 w-4" />
                        ) : (
                          <Bot className="h-4 w-4" />
                        )}
                      </div>

                      <div
                        className={`flex flex-col gap-2 ${msg.role === "user" ? "max-w-[80%] items-end" : "min-w-0 flex-1 items-start"}`}
                      >
                        {msg.role === "user" ? (
                          <div className="p-3 rounded-xl text-sm bg-secondary text-secondary-foreground">
                            <div className="whitespace-pre-wrap break-words">
                              {msg.content}
                            </div>
                          </div>
                        ) : (
                          <StructuredAnswer
                            content={msg.content}
                            citations={msg.citations}
                            usedInternalKnowledge={msg.usedInternalKnowledge}
                            onCitationClick={onCitationClick}
                            onFieldNoteClick={onFieldNoteClick}
                          />
                        )}
                        {messageTime && (
                          <span className="text-[11px] text-muted-foreground">
                            {messageTime}
                          </span>
                        )}
                      </div>
                    </motion.div>
                  );
                })
              )}
              {askJack?.isPending && (
                <div className="flex gap-3">
                  <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center flex-shrink-0 text-primary-foreground">
                    <Bot className="h-4 w-4" />
                  </div>
                  <div className="p-3 rounded-xl bg-card border border-card-border flex items-center">
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                    <span className="ml-2 text-xs font-mono">
                      {getLoadingCopy()}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </ScrollArea>

          <div className="p-4 pb-[max(1rem,env(safe-area-inset-bottom))] bg-sidebar-primary/5 border-t border-sidebar-border space-y-2 shrink-0">
            {errorMessage && (
              <div
                role="alert"
                aria-live="polite"
                data-testid="ask-jack-error"
                className="text-sm text-destructive rounded-lg border border-destructive/40 bg-destructive/10 p-3 font-mono"
              >
                {errorMessage}
              </div>
            )}
            {speechSupported && (
              <div className="space-y-2 rounded-lg border border-sidebar-border bg-sidebar p-2">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => handleSetSpeechEnabled(!speechEnabled)}
                      className="h-8 px-2"
                    >
                      {speechEnabled ? (
                        <>
                          <Volume2 className="mr-1.5 h-3.5 w-3.5" />
                          Voice On
                        </>
                      ) : (
                        <>
                          <VolumeX className="mr-1.5 h-3.5 w-3.5" />
                          Voice Off
                        </>
                      )}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={handleToggleSpeechPause}
                      disabled={!speechEnabled}
                      className="h-8 px-2"
                    >
                      {speechPaused ? (
                        <>
                          <Play className="mr-1.5 h-3.5 w-3.5" />
                          Resume Jack
                        </>
                      ) : (
                        <>
                          <Pause className="mr-1.5 h-3.5 w-3.5" />
                          Pause Jack
                        </>
                      )}
                    </Button>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={increaseSpeechVolumeByTenPercent}
                    disabled={!speechEnabled}
                    className="h-8 px-2"
                  >
                    +10%
                  </Button>
                </div>
                <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>Vol {Math.round(speechVolume * 100)}%</span>
                  <div className="w-1/2 h-1 rounded-full bg-border">
                    <div
                      className="h-full rounded-full bg-primary transition-all"
                      style={{ width: `${Math.round(speechVolume * 100)}%` }}
                    />
                  </div>
                </div>
              </div>
            )}
            {messages.length > 0 && (
              <div className="flex justify-end">
                <ParkThisThoughtButton
                  source="chat"
                  context={messages.slice(-5).map((m) => ({
                    role: m.role === "assistant" ? "assistant" : "user",
                    text: m.content,
                  }))}
                />
              </div>
            )}
            <form onSubmit={handleSubmit} className="relative">
              {steerChoiceMessage && (
                <div className="mb-2 rounded-md border border-primary/40 bg-primary/10 p-2 text-xs">
                  <p className="font-medium text-sidebar-foreground/80">
                    Jack’s still thinking. What should happen?
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={handleWait}
                    >
                      Wait
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={closeSteerChoice}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
              <Input
                ref={inputRef}
                data-testid="chat-input"
                value={input}
                onChange={(e) => onInputChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape" && steerChoiceMessage) {
                    e.preventDefault();
                    closeSteerChoice();
                  }
                }}
                placeholder="What’s going on?"
                aria-label="Ask Jack a question"
                className="h-11 pr-12 bg-card border-card-border focus-visible:ring-primary text-base md:h-9 md:text-sm"
              />
              <Button
                type="submit"
                size="icon"
                data-testid="send-button"
                aria-label="Send question"
                className="absolute right-1 top-1 h-9 w-9 bg-primary hover:bg-primary/90 text-primary-foreground md:h-8 md:w-8"
                disabled={!input.trim()}
              >
                <Send className="h-4 w-4" />
              </Button>
            </form>
          </div>
        </motion.div>
      )}

      <AlertDialog
        open={confirmingClear}
        onOpenChange={(open) => {
          if (!open && !clearHistory.isPending) setConfirmingClear(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Start a new conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              This clears your saved Ask Jack chat history. It can't be undone,
              but the knowledge library itself is untouched — you can always ask
              again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={clearHistory.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={clearHistory.isPending}
              onClick={(e) => {
                e.preventDefault();
                handleClearConversation();
              }}
              className="bg-red-600 text-white hover:bg-red-500"
            >
              {clearHistory.isPending ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <RotateCcw className="mr-1.5 h-4 w-4" />
              )}
              Start fresh
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AnimatePresence>
  );
}
