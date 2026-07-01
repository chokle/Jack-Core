import { useState, useRef, useEffect } from "react";
import { Send, Bot, User, X, Loader2, Sparkles, BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAskJack, useGetChatHistory, ChatMessage } from "@workspace/api-client-react";
import { motion, AnimatePresence } from "framer-motion";

// Session identity is managed entirely by the server via an HttpOnly cookie.
// The client does not read, store, or transmit any session identifier —
// the browser sends the cookie automatically on every /api request.

interface AskJackProps {
  isOpen: boolean;
  onClose: () => void;
  initialContext?: string;
  onCitationClick: (videoId: string, startTime: number) => void;
}

export function AskJack({ isOpen, onClose, initialContext, onCitationClick }: AskJackProps) {
  const [input, setInput] = useState(initialContext || "");
  const scrollRef = useRef<HTMLDivElement>(null);

  // No sessionId parameter — the server resolves the session from the cookie.
  const { data: history } = useGetChatHistory();
  // @ts-ignore
  const askJack = useAskJack?.();

  const [messages, setMessages] = useState<ChatMessage[]>([]);

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
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || askJack?.isPending) return;

    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      role: "user",
      content: input,
      createdAt: new Date().toISOString()
    };

    setMessages(prev => [...prev, userMessage]);
    setInput("");

    if (askJack) {
      askJack.mutate(
        // sessionId is omitted — the server binds the request to the caller's
        // HttpOnly cookie session and ignores any id in the body.
        // @ts-ignore
        { data: { message: userMessage.content } },
        {
          onSuccess: (data: any) => {
            const assistantMessage: ChatMessage = {
              id: Date.now().toString(),
              role: "assistant",
              content: data.answer,
              citations: data.citations,
              createdAt: new Date().toISOString()
            };
            setMessages(prev => [...prev, assistantMessage]);
          }
        }
      );
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ x: "100%", opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: "100%", opacity: 0 }}
          transition={{ type: "spring", damping: 25, stiffness: 200 }}
          className="fixed top-0 right-0 h-screen w-full sm:w-[450px] bg-sidebar border-l border-sidebar-border shadow-2xl flex flex-col z-50"
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
                    
                    <div className={`flex flex-col gap-2 max-w-[80%] ${msg.role === "user" ? "items-end" : "items-start"}`}>
                      <div className={`p-3 rounded-xl text-sm ${msg.role === "user" ? "bg-secondary text-secondary-foreground" : "bg-card border border-card-border"}`}>
                        <div className="whitespace-pre-wrap break-words">{msg.content}</div>
                      </div>
                      
                      {msg.citations && msg.citations.length > 0 && (
                        <div className="mt-2 space-y-2 w-full">
                          <div className="flex items-center text-xs font-mono text-muted-foreground mb-1">
                            <BookOpen className="h-3 w-3 mr-1" /> Sources
                          </div>
                          {msg.citations.map((cite, i) => (
                            <button
                              key={i}
                              onClick={() => onCitationClick(cite.videoId, cite.startTime)}
                              className="w-full text-left bg-muted/30 hover:bg-muted/80 border border-border rounded p-2 text-xs transition-colors flex gap-2"
                            >
                              <div className="w-10 h-6 bg-zinc-800 rounded overflow-hidden flex-shrink-0">
                                {cite.thumbnailUrl && <img src={cite.thumbnailUrl} className="w-full h-full object-cover" alt="" />}
                              </div>
                              <div className="overflow-hidden">
                                <div className="font-semibold truncate">{cite.videoTitle}</div>
                                <div className="text-[10px] font-mono text-primary">
                                  {Math.floor(cite.startTime / 60)}:{(cite.startTime % 60).toString().padStart(2, '0')}
                                </div>
                              </div>
                            </button>
                          ))}
                        </div>
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

          <div className="p-4 bg-sidebar-primary/5 border-t border-sidebar-border">
            <form onSubmit={handleSubmit} className="relative">
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask about red seal standards..."
                className="pr-12 bg-card border-card-border focus-visible:ring-primary"
                disabled={askJack?.isPending}
              />
              <Button 
                type="submit" 
                size="icon" 
                className="absolute right-1 top-1 h-8 w-8 bg-primary hover:bg-primary/90 text-primary-foreground"
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
