import { useState, useRef, useEffect } from "react";
import { Send, Bot, User, X, Loader2, Sparkles, Bookmark } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  useAskJack,
  useGetChatHistory,
  ChatMessage,
  type ParkedThought,
} from "@workspace/api-client-react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { StructuredAnswer } from "@/components/StructuredAnswer";
import { ParkThisThoughtButton } from "@/components/ParkedThoughts";
import { timeAgo } from "@/lib/memory-graph";

type DisplayMessage = ChatMessage & { usedInternalKnowledge?: boolean };

// Session identity is managed entirely by the server via an HttpOnly cookie.
// The client does not read, store, or transmit any session identifier —
// the browser sends the cookie automatically on every /api request.

interface AskJackProps {
  isOpen: boolean;
  onClose: () => void;
  initialContext?: string;
  onCitationClick: (videoId: string, startTime: number) => void;
  /** Set when the drawer was opened via "Resume" on a parked thought. */
  resumedThought?: ParkedThought;
}

export function AskJack({
  isOpen,
  onClose,
  initialContext,
  onCitationClick,
  resumedThought,
}: AskJackProps) {
  const [input, setInput] = useState(initialContext || "");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const prefersReducedMotion = useReducedMotion();

  // No sessionId parameter — the server resolves the session from the cookie.
  const { data: history } = useGetChatHistory();
  const askJack = useAskJack();

  const [messages, setMessages] = useState<DisplayMessage[]>([]);

  useEffect(() => {
    setBannerDismissed(false);
  }, [resumedThought?.id]);

  useEffect(() => {
    if (history && history.length > 0 && messages.length === 0) {
      setMessages(history);
    }
  }, [history]);

  useEffect(() => {
    if (initialContext) {
      setInput(initialContext);
    }
  }, [initialContext]);

  useEffect(() => {
    if (!isOpen) return undefined;
    // Focus as soon as the drawer opens so automation (and keyboard users)
    // don't have to wait for/race the entrance animation.
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [isOpen]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || askJack.isPending) return;

    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      role: "user",
      content: input,
      createdAt: new Date().toISOString()
    };

    setMessages(prev => [...prev, userMessage]);
    setInput("");

    // sessionId is omitted — the server binds the request to the caller's
    // HttpOnly cookie session and ignores any id in the body.
    askJack.mutate(
      { data: { message: userMessage.content } },
      {
        onSuccess: (data) => {
          const assistantMessage: DisplayMessage = {
            id: Date.now().toString(),
            role: "assistant",
            content: data.answer,
            citations: data.citations,
            usedInternalKnowledge: data.usedInternalKnowledge,
            createdAt: new Date().toISOString()
          };
          setMessages(prev => [...prev, assistantMessage]);
        }
      }
    );
  };

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
                <h2 className="font-semibold tracking-tight text-sidebar-foreground">Ask Jack</h2>
                <p className="text-[10px] font-mono text-sidebar-foreground/60 uppercase">Intelligence Engine</p>
              </div>
            </div>
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>

          {resumedThought && !bannerDismissed && (
            <div className="flex items-start justify-between gap-2 border-b border-amber-400/30 bg-amber-400/10 px-4 py-2.5">
              <div className="flex items-start gap-2">
                <Bookmark className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
                <p className="text-xs leading-relaxed text-amber-200/90">
                  Picking up where you left off — parked {timeAgo(resumedThought.createdAt)}
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
                    I have indexed the entire trade knowledge base. Ask me anything.
                  </p>
                </div>
              ) : (
                messages.map((msg) => (
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    key={msg.id} 
                    className={`flex gap-3 ${msg.role === "user" ? "flex-row-reverse" : ""}`}
                  >
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${msg.role === "user" ? "bg-secondary" : "bg-primary text-primary-foreground"}`}>
                      {msg.role === "user" ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
                    </div>
                    
                    <div className={`flex flex-col gap-2 ${msg.role === "user" ? "max-w-[80%] items-end" : "min-w-0 flex-1 items-start"}`}>
                      {msg.role === "user" ? (
                        <div className="p-3 rounded-xl text-sm bg-secondary text-secondary-foreground">
                          <div className="whitespace-pre-wrap break-words">{msg.content}</div>
                        </div>
                      ) : (
                        <StructuredAnswer
                          content={msg.content}
                          citations={msg.citations}
                          usedInternalKnowledge={msg.usedInternalKnowledge}
                          onCitationClick={onCitationClick}
                        />
                      )}
                    </div>
                  </motion.div>
                ))
              )}
              {askJack?.isPending && (
                <div className="flex gap-3">
                  <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center flex-shrink-0 text-primary-foreground">
                    <Bot className="h-4 w-4" />
                  </div>
                  <div className="p-3 rounded-xl bg-card border border-card-border flex items-center">
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                    <span className="ml-2 text-xs font-mono">Analyzing library...</span>
                  </div>
                </div>
              )}
            </div>
          </ScrollArea>

          <div className="p-4 pb-[max(1rem,env(safe-area-inset-bottom))] bg-sidebar-primary/5 border-t border-sidebar-border space-y-2 shrink-0">
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
              <Input
                ref={inputRef}
                data-testid="chat-input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask about red seal standards..."
                className="h-11 pr-12 bg-card border-card-border focus-visible:ring-primary text-base md:h-9 md:text-sm"
                disabled={askJack?.isPending}
              />
              <Button 
                type="submit" 
                size="icon" 
                data-testid="send-button"
                className="absolute right-1 top-1 h-9 w-9 bg-primary hover:bg-primary/90 text-primary-foreground md:h-8 md:w-8"
                disabled={!input.trim() || askJack?.isPending}
              >
                <Send className="h-4 w-4" />
              </Button>
            </form>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
