import { useState, useRef, useEffect } from "react";
import { X, ArrowLeft, Play, Clock, BrainCircuit, MessageSquare, Subtitles, ListChecks, FileQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useGetVideo, useTranscribeVideo, useAnalyzeVideo, useFetchRelatedVideos } from "@workspace/api-client-react";
import { motion, AnimatePresence } from "framer-motion";
import { Skeleton } from "@/components/ui/skeleton";
import { IN_FLIGHT_STATUSES } from "@/lib/video-status";

interface VideoDetailProps {
  videoId: string;
  onBack: () => void;
  onOpenChat: (context?: string) => void;
  seek?: { time: number; token: number };
}

export function VideoDetail({ videoId, onBack, onOpenChat, seek }: VideoDetailProps) {
  const [activeTab, setActiveTab] = useState<"transcript" | "analysis">("analysis");
  const videoRef = useRef<HTMLVideoElement>(null);

  const { data: video, isLoading } = useGetVideo(videoId, {
    query: {
      enabled: !!videoId,
      queryKey: ['video', videoId],
      // Poll while the pipeline is running so the UI advances
      // queued -> transcribing -> analyzing -> indexing -> completed without a
      // manual refresh.
      refetchInterval: (query) => {
        const status = (query.state.data as { status?: string } | undefined)?.status;
        return status && IN_FLIGHT_STATUSES.has(status) ? 4000 : false;
      },
    },
  });

  const { data: relatedVideos } = useFetchRelatedVideos(videoId, { query: { enabled: !!videoId, queryKey: ['related', videoId] } });

  const transcribeMutation = useTranscribeVideo();
  const analyzeMutation = useAnalyzeVideo();

  const seekVideo = (time: number) => {
    const el = videoRef.current;
    if (!el) return;
    el.currentTime = time;
    void el.play().catch(() => {});
  };

  // Jump the player to a cited timestamp. Keyed on the seek token so clicking
  // the same citation again still re-seeks; waits for metadata if needed.
  useEffect(() => {
    if (!seek || !video?.videoUrl) return;
    const el = videoRef.current;
    if (!el) return;
    const apply = () => {
      el.currentTime = seek.time;
      void el.play().catch(() => {});
    };
    if (el.readyState >= 1) {
      apply();
      return;
    }
    el.addEventListener("loadedmetadata", apply, { once: true });
    return () => el.removeEventListener("loadedmetadata", apply);
  }, [seek?.token, video?.videoUrl]);

  if (isLoading) {
    return (
      <div className="flex-1 flex flex-col h-full bg-background p-6">
        <Skeleton className="h-8 w-32 mb-6" />
        <div className="flex gap-6 h-[calc(100vh-100px)]">
          <div className="flex-1 space-y-4">
            <Skeleton className="aspect-video w-full rounded-xl" />
            <Skeleton className="h-10 w-2/3" />
            <Skeleton className="h-24 w-full" />
          </div>
          <div className="w-96 space-y-4">
            <Skeleton className="h-[400px] w-full rounded-xl" />
            <Skeleton className="h-[400px] w-full rounded-xl" />
          </div>
        </div>
      </div>
    );
  }

  if (!video) {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="flex-1 flex flex-col h-full bg-background"
      >
        <div className="flex-none p-4 border-b border-border flex items-center bg-card/50 backdrop-blur">
          <Button variant="ghost" size="sm" onClick={onBack} className="font-mono text-xs">
            <ArrowLeft className="h-4 w-4 mr-2" /> Back to Library
          </Button>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center text-center p-6 gap-4">
          <FileQuestion className="h-12 w-12 text-muted-foreground opacity-40" />
          <div>
            <h2 className="text-lg font-semibold">This video couldn't be opened</h2>
            <p className="text-sm text-muted-foreground mt-1 max-w-sm mx-auto">
              It may have been removed, or it's still finishing setup. Go back and try selecting it again.
            </p>
          </div>
          <Button size="sm" onClick={onBack}>
            <ArrowLeft className="h-4 w-4 mr-2" /> Back to Library
          </Button>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div 
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      className="flex-1 flex flex-col h-full bg-background"
    >
      <div className="flex-none p-4 border-b border-border flex items-center justify-between bg-card/50 backdrop-blur">
        <Button variant="ghost" size="sm" onClick={onBack} className="font-mono text-xs">
          <ArrowLeft className="h-4 w-4 mr-2" /> Back to Library
        </Button>
        <div className="flex items-center gap-2">
          {(video.status === "queued" || video.status === "uploaded" || video.status === "failed") && (
            <Button size="sm" onClick={() => transcribeMutation.mutate({ id: video.id })}>
              {video.status === "failed" ? "Retry Processing" : "Run Transcription"}
            </Button>
          )}
          {video.status === "completed" && !video.analysis && (
            <Button size="sm" onClick={() => analyzeMutation.mutate({ id: video.id })}>
              <BrainCircuit className="h-4 w-4 mr-2" /> Analyze
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={() => onOpenChat(`Based on the video "${video.title}"...`)}>
            <MessageSquare className="h-4 w-4 mr-2" /> Ask Jack
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-hidden flex flex-col lg:flex-row">
        {/* Main Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          <div className="aspect-video bg-black rounded-xl overflow-hidden relative border border-border">
            {video.videoUrl ? (
              <video ref={videoRef} src={video.videoUrl} controls className="w-full h-full object-contain" />
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground">
                <Play className="h-16 w-16 mb-4 opacity-20" />
                <p className="font-mono text-sm">Video Source Unavailable</p>
              </div>
            )}
          </div>

          <div>
            <div className="flex gap-2 mb-3">
              <Badge variant="outline" className="font-mono">{video.trade}</Badge>
              {video.competencyCodes?.map(code => (
                <Badge key={code} variant="secondary" className="font-mono text-primary bg-primary/10">{code}</Badge>
              ))}
            </div>
            <h1 className="text-3xl font-bold tracking-tight mb-2">{video.title}</h1>
            <p className="text-muted-foreground leading-relaxed">{video.description}</p>
            {video.status === "failed" && (
              <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 p-3">
                <p className="font-mono text-xs text-destructive">
                  Processing failed{video.lastError ? `: ${video.lastError}` : "."}
                </p>
                <p className="font-mono text-xs text-muted-foreground mt-1">
                  Use "Retry Processing" above to try again.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Sidebar Panel */}
        <div className="w-full lg:w-[400px] border-l border-border bg-sidebar flex flex-col h-[calc(100vh-73px)]">
          <div className="flex p-2 gap-1 border-b border-border bg-card">
            <button 
              onClick={() => setActiveTab("analysis")}
              className={`flex-1 py-2 px-3 text-sm font-medium rounded-md flex items-center justify-center transition-colors ${activeTab === "analysis" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
            >
              <BrainCircuit className="h-4 w-4 mr-2" /> Analysis
            </button>
            <button 
              onClick={() => setActiveTab("transcript")}
              className={`flex-1 py-2 px-3 text-sm font-medium rounded-md flex items-center justify-center transition-colors ${activeTab === "transcript" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
            >
              <Subtitles className="h-4 w-4 mr-2" /> Transcript
            </button>
          </div>

          <ScrollArea className="flex-1">
            <div className="p-4 space-y-6">
              {activeTab === "analysis" ? (
                <div className="space-y-6">
                  {video.analysis ? (
                    <div className="prose prose-invert max-w-none text-sm">
                      <div className="whitespace-pre-wrap break-words">{video.analysis}</div>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground border border-dashed border-border rounded-lg">
                      <BrainCircuit className="h-8 w-8 mb-2 opacity-50" />
                      <p className="font-mono text-xs">No analysis available.</p>
                      {video.status === "completed" && (
                        <Button variant="link" size="sm" className="mt-2 text-primary" onClick={() => analyzeMutation.mutate({ id: video.id })}>
                          Trigger Analysis
                        </Button>
                      )}
                    </div>
                  )}

                  {video.keyPoints && video.keyPoints.length > 0 && (
                    <div className="space-y-3">
                      <h3 className="font-semibold flex items-center text-sm">
                        <ListChecks className="h-4 w-4 mr-2 text-primary" /> Key Takeaways
                      </h3>
                      <ul className="space-y-2">
                        {video.keyPoints.map((point, i) => (
                          <li key={i} className="text-sm bg-muted/50 p-3 rounded-lg border border-border/50">
                            {point}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-4">
                  {video.segments && video.segments.length > 0 ? (
                    video.segments.map((segment, i) => (
                      <div
                        key={i}
                        onClick={() => seekVideo(segment.startTime)}
                        className="group flex gap-3 hover:bg-muted/50 p-2 -mx-2 rounded-lg cursor-pointer transition-colors"
                      >
                        <div className="font-mono text-xs text-primary pt-0.5">
                          {Math.floor(segment.startTime / 60)}:{(segment.startTime % 60).toString().padStart(2, '0')}
                        </div>
                        <p className="text-sm text-foreground/90 group-hover:text-foreground">
                          {segment.text}
                        </p>
                      </div>
                    ))
                  ) : (
                    <p className="text-sm text-muted-foreground text-center py-8">Transcript not available.</p>
                  )}
                </div>
              )}
            </div>
          </ScrollArea>
        </div>
      </div>
    </motion.div>
  );
}
