import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Library } from "./components/Library";
import { VideoDetail } from "./components/VideoDetail";
import { InterviewMode } from "./components/InterviewMode";
import { KnowledgeReview } from "./components/KnowledgeReview";
import { AskJack } from "./components/AskJack";
import { KnowledgeGraph } from "./components/KnowledgeGraph";
import { JackShell, type JackView } from "./components/JackShell";
import { MemoryGraphView } from "./components/MemoryGraphView";
import { useMemoryGraphData } from "./lib/use-memory-graph";
import { timeAgo } from "./lib/memory-graph";
import type { ParkedThought } from "@workspace/api-client-react";

const queryClient = new QueryClient();

function JackApp() {
  const [view, setView] = useState<JackView>("graph");
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [chatContext, setChatContext] = useState<string | undefined>();
  // Set when the drawer is opened via "Resume" on a parked chat thought — shows
  // a reorientation banner atop the conversation. Cleared on close so the next
  // plain "Ask Jack" open (no resume) doesn't show a stale banner.
  const [resumedThought, setResumedThought] = useState<ParkedThought | null>(null);
  // A monotonically-increasing token so clicking the *same* citation twice still
  // re-triggers a seek; `time` is the target position in seconds.
  const [seek, setSeek] = useState<{ time: number; token: number } | undefined>();

  const graph = useMemoryGraphData();

  const handleOpenChat = (context?: string) => {
    setResumedThought(null);
    setChatContext(context);
    setIsChatOpen(true);
  };

  // Resume a parked Ask Jack conversation: prefill the input with whatever was
  // left unfinished and surface a reorientation banner. The full conversation
  // itself is already restored for free — chat history is loaded by session
  // cookie, and a parked thought is always the caller's own session.
  const handleResumeChat = (thought: ParkedThought) => {
    setResumedThought(thought);
    setChatContext(thought.unfinishedThought ?? undefined);
    setIsChatOpen(true);
  };

  const handleSelectVideo = (videoId: string) => {
    setSeek(undefined);
    setSelectedVideoId(videoId);
  };

  const handleNavigate = (next: JackView) => {
    setSelectedVideoId(null);
    setView(next);
  };

  const handleCitationClick = (videoId: string, startTime: number) => {
    setSelectedVideoId(videoId);
    setSeek({ time: startTime, token: Date.now() });
  };

  // Resume an interrupted interview from a mentor node in the Living Memory
  // graph. We stash the session id under the SAME localStorage key Interview
  // Mode reads on mount ("jack.interview.activeSessionId") and switch to that
  // view — Interview Mode's existing resume-on-mount logic then reconnects to
  // exactly where the mentor left off. Kept as a literal (not imported from
  // InterviewMode) so this path stays decoupled from that component's internals.
  const handleResumeInterview = (sessionId: string) => {
    try {
      localStorage.setItem("jack.interview.activeSessionId", sessionId);
    } catch {
      // Storage unavailable (private mode) — Interview Mode will start fresh.
    }
    setSelectedVideoId(null);
    setView("interview");
  };

  const inGraph = view === "graph" && !selectedVideoId;
  const activeNav: JackView = selectedVideoId ? "library" : view;

  return (
    <>
      {/* Ambient memory wallpaper behind the library / detail surfaces. The
          Memory Graph view renders its own full-bleed interactive canvas. */}
      {!inGraph && <KnowledgeGraph />}

      <JackShell
        active={activeNav}
        onNavigate={handleNavigate}
        onOpenChat={() => handleOpenChat()}
        model={graph.model}
        readyCount={graph.readyCount}
        lastUpdatedLabel={graph.lastUpdated ? timeAgo(graph.lastUpdated) : "—"}
      >
        {selectedVideoId ? (
          <VideoDetail
            videoId={selectedVideoId}
            onBack={() => setSelectedVideoId(null)}
            onOpenChat={handleOpenChat}
            seek={seek}
          />
        ) : view === "graph" ? (
          <MemoryGraphView
            data={graph}
            onOpenVideo={handleSelectVideo}
            onJumpToTimestamp={handleCitationClick}
            onResumeInterview={handleResumeInterview}
            onResumeChat={handleResumeChat}
            onStartInterview={() => handleNavigate("interview")}
          />
        ) : view === "interview" ? (
          <InterviewMode />
        ) : view === "review" ? (
          <KnowledgeReview />
        ) : (
          <Library onSelectVideo={handleSelectVideo} />
        )}
      </JackShell>

      {/* Chat Drawer overlay */}
      <AskJack
        isOpen={isChatOpen}
        onClose={() => {
          setIsChatOpen(false);
          setResumedThought(null);
        }}
        resumedThought={resumedThought ?? undefined}
        initialContext={chatContext}
        onCitationClick={handleCitationClick}
      />
    </>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <JackApp />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
