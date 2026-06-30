import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Library } from "./components/Library";
import { VideoDetail } from "./components/VideoDetail";
import { AskJack } from "./components/AskJack";
import { Bot, LogOut, Settings, Database } from "lucide-react";

const queryClient = new QueryClient();

function JackApp() {
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [chatContext, setChatContext] = useState<string | undefined>();

  const handleOpenChat = (context?: string) => {
    setChatContext(context);
    setIsChatOpen(true);
  };

  const handleCitationClick = (videoId: string, startTime: number) => {
    setSelectedVideoId(videoId);
    // In a full implementation, we'd also seek the video to startTime
  };

  return (
    <div className="flex h-screen w-full bg-background overflow-hidden text-foreground selection:bg-primary/30">
      {/* Sidebar / Navigation (Mini) */}
      <div className="w-16 bg-sidebar border-r border-border flex flex-col items-center py-4 z-10 relative">
        <div className="w-10 h-10 rounded-xl bg-primary flex items-center justify-center text-primary-foreground shadow-[0_0_15px_rgba(255,100,0,0.4)] mb-8 cursor-pointer" onClick={() => setSelectedVideoId(null)}>
          <span className="font-black text-xl tracking-tighter">J</span>
        </div>
        
        <nav className="flex flex-col gap-4 flex-1 w-full items-center">
          <button onClick={() => setSelectedVideoId(null)} className={`w-10 h-10 rounded-lg flex items-center justify-center transition-colors ${!selectedVideoId ? "bg-primary/20 text-primary" : "text-muted-foreground hover:bg-muted"}`} title="Library">
            <Database className="h-5 w-5" />
          </button>
          <button onClick={() => handleOpenChat()} className={`w-10 h-10 rounded-lg flex items-center justify-center transition-colors ${isChatOpen ? "bg-primary/20 text-primary" : "text-muted-foreground hover:bg-muted"}`} title="Ask Jack">
            <Bot className="h-5 w-5" />
          </button>
        </nav>
        
        <div className="flex flex-col gap-4">
          <button className="w-10 h-10 rounded-lg flex items-center justify-center text-muted-foreground hover:bg-muted transition-colors">
            <Settings className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* Main Content Area */}
      <main className="flex-1 relative flex overflow-hidden">
        {selectedVideoId ? (
          <VideoDetail 
            videoId={selectedVideoId} 
            onBack={() => setSelectedVideoId(null)} 
            onOpenChat={handleOpenChat}
          />
        ) : (
          <Library onSelectVideo={setSelectedVideoId} />
        )}
      </main>

      {/* Chat Drawer overlay */}
      <AskJack 
        isOpen={isChatOpen} 
        onClose={() => setIsChatOpen(false)} 
        initialContext={chatContext}
        onCitationClick={handleCitationClick}
      />
    </div>
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
