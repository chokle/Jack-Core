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

const queryClient = new QueryClient();

function JackApp() {
  const [view, setView] = useState<JackView>("graph");
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [chatContext, setChatContext] = useState<string | undefined>();
  // A monotonically-increasing token so clicking the *same* citation twice still
  // re-triggers a seek; `time` is the target position in seconds.
  const [seek, setSeek] = useState<{ time: number; token: number } | undefined>();

  const graph = useMemoryGraphData();

  const handleOpenChat = (context?: string) => {
    setChatContext(context);
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
        onClose={() => setIsChatOpen(false)}
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
