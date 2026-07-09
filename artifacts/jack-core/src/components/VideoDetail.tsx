import { useState, useRef, useEffect } from "react";
import { X, ArrowLeft, Play, Clock, BrainCircuit, MessageSquare, Subtitles, ListChecks, FileQuestion, Trash2, AlertTriangle, Download, UserPlus, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  useGetVideo,
  useTranscribeVideo,
  useAnalyzeVideo,
  useFetchRelatedVideos,
  useDeleteVideo,
  useGetMe,
  getListVideosQueryKey,
  getGetVideoStatsQueryKey,
  getGetRecentVideosQueryKey,
  getGetVideoQueryKey,
  getGetGraphQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
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
  const { toast } = useToast();

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

  // Jack can successfully transcribe/analyze a video file whose container or
  // codec the browser's <video> element can't decode (e.g. some .mov/.mkv/.avi
  // sources). That's a client-side preview limitation, not a processing
  // failure — never let it affect video.status. We just swap the player area
  // for a friendly explanation instead of surfacing the browser's native
  // "No video with supported format and MIME type found" error.
  const [playbackUnsupported, setPlaybackUnsupported] = useState(false);
  useEffect(() => {
    setPlaybackUnsupported(false);
  }, [videoId, video?.videoUrl]);

  const { data: relatedVideos } = useFetchRelatedVideos(videoId, { query: { enabled: !!videoId, queryKey: ['related', videoId] } });

  const transcribeMutation = useTranscribeVideo();
  const analyzeMutation = useAnalyzeVideo();

  const queryClient = useQueryClient();

  // Admins can remove library records. Non-admins can only remove their own
  // duplicate uploads; the server enforces that rule and this only reflects it.
  const me = useGetMe().data;
  const isAdmin = me?.isAdmin ?? false;
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [claimingContributor, setClaimingContributor] = useState(false);

  const deleteMutation = useDeleteVideo({
    request: { credentials: "include" },
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getListVideosQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getGetVideoStatsQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getGetRecentVideosQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getGetGraphQueryKey() });
        setConfirmDeleteOpen(false);
        onBack();
      },
      onError: (err) => {
        toast({
          title: "Could not remove video",
          description: err instanceof Error ? err.message : "Only your own duplicate uploads can be removed.",
          variant: "destructive",
        });
      },
    },
  });

  const hasUploader =
    Boolean((video as { uploaderUserId?: string | null } | undefined)?.uploaderUserId) ||
    Boolean((video as { uploader_user_id?: string | null } | undefined)?.uploader_user_id);
  const duplicateDelete = video as {
    uploaderUserId?: string | null;
    uploader_user_id?: string | null;
    canDeleteDuplicate?: boolean;
    duplicateCount?: number;
  };
  const uploaderUserId = duplicateDelete.uploaderUserId ?? duplicateDelete.uploader_user_id ?? null;
  const canRemoveOwnDuplicate =
    !isAdmin &&
    Boolean(me?.userId) &&
    uploaderUserId === me?.userId &&
    duplicateDelete.canDeleteDuplicate === true;
  const canDeleteVideo = isAdmin || canRemoveOwnDuplicate;
  const status = video?.status ?? "";
  const isWorking = IN_FLIGHT_STATUSES.has(status);
  const isAnalyzingNow = status === "analyzing";
  const processingSteps = [
    { id: "transcribing", label: "Reading the footage", active: status === "transcribing", done: Boolean(video?.transcript) },
    { id: "analyzing", label: "Finding lessons and risks", active: status === "analyzing", done: Boolean(video?.analysis) },
    { id: "indexing", label: "Linking it into memory", active: status === "indexing", done: status === "completed" },
  ];

  const claimContributor = async () => {
    if (!video?.id) return;
    setClaimingContributor(true);
    try {
      const res = await fetch(`/api/videos/${video.id}/claim-contributor`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Attach failed (${res.status})`);
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getGetVideoQueryKey(video.id) }),
        queryClient.invalidateQueries({ queryKey: getListVideosQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetRecentVideosQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetGraphQueryKey() }),
      ]);
      toast({
        title: "Contributor attached",
        description: "This video now sits under your node in Jack's memory graph.",
      });
    } catch (err) {
      toast({
        title: "Could not attach contributor",
        description: err instanceof Error ? err.message : "Try again after refreshing.",
        variant: "destructive",
      });
    } finally {
      setClaimingContributor(false);
    }
  };

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
          {isAdmin && !hasUploader && (
            <Button
              size="sm"
              variant="secondary"
              onClick={claimContributor}
              disabled={claimingContributor}
            >
              <UserPlus className="h-4 w-4 mr-2" />
              {claimingContributor ? "Attaching..." : "Attach to Me"}
            </Button>
          )}
          {canDeleteVideo && (
            <Button
              size="sm"
              variant="destructive"
              onClick={() => setConfirmDeleteOpen(true)}
              disabled={deleteMutation.isPending}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              {deleteMutation.isPending ? "Deleting..." : isAdmin ? "Delete" : "Remove duplicate"}
            </Button>
          )}
          {((video.status === "completed" && !video.analysis) || isAnalyzingNow) && (
            <Button
              size="sm"
              onClick={() => analyzeMutation.mutate({ id: video.id })}
              disabled={isAnalyzingNow || analyzeMutation.isPending}
            >
              {isAnalyzingNow || analyzeMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <BrainCircuit className="h-4 w-4 mr-2" />
              )}
              {isAnalyzingNow || analyzeMutation.isPending ? "Jack is analyzing..." : "Generate Analysis"}
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={() => onOpenChat(`Based on the video "${video.title}"...`)}>
            <MessageSquare className="h-4 w-4 mr-2" /> Ask Jack
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto lg:overflow-hidden flex flex-col lg:flex-row">
        {/* Main Content */}
        <div className="flex-1 lg:overflow-y-auto p-6 space-y-6">
          <div className="aspect-video bg-black rounded-xl overflow-hidden relative border border-border">
            {video.videoUrl && !playbackUnsupported ? (
              <video
                ref={videoRef}
                src={video.videoUrl}
                controls
                className="w-full h-full object-contain"
                onError={() => setPlaybackUnsupported(true)}
              />
            ) : video.videoUrl && playbackUnsupported ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-center text-muted-foreground p-6 gap-3">
                <AlertTriangle className="h-10 w-10 text-amber-500" />
                <div>
                  <p className="font-semibold text-foreground">
                    Jack analyzed this video, but this file format can't be previewed in your browser.
                  </p>
                  <p className="text-sm text-muted-foreground mt-1 max-w-sm mx-auto">
                    The transcript and analysis below are unaffected. For in-browser playback, convert the
                    source to MP4 (H.264 video / AAC audio) and re-upload.
                  </p>
                </div>
                <Button size="sm" variant="secondary" asChild>
                  <a href={video.videoUrl} download target="_blank" rel="noopener noreferrer">
                    <Download className="h-4 w-4 mr-2" /> Download original
                  </a>
                </Button>
              </div>
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
                  Use "Retry Processing" above to try again{canDeleteVideo ? ", or remove this entry from the Library." : "."}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Sidebar Panel */}
        <div className="w-full lg:w-[400px] border-l border-border bg-sidebar flex flex-col lg:h-[calc(100vh-73px)]">
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

          <ScrollArea className="flex-1 overflow-visible lg:overflow-hidden">
            <div className="p-4 space-y-6">
              {activeTab === "analysis" ? (
                <div className="space-y-6">
                  {isWorking && !video.analysis && (
                    <div className="rounded-xl border border-primary/25 bg-primary/5 p-4">
                      <div className="flex items-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin text-primary" />
                        <div>
                          <h3 className="text-sm font-semibold text-foreground">
                            Jack is working through this upload
                          </h3>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            Keep this open to watch the analysis take shape, or come back later.
                          </p>
                        </div>
                      </div>
                      <div className="mt-4 space-y-2">
                        {processingSteps.map((step) => (
                          <div
                            key={step.id}
                            className={`flex items-center justify-between rounded-lg border px-3 py-2 text-xs ${
                              step.active
                                ? "border-primary/40 bg-primary/10 text-foreground"
                                : step.done
                                  ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-200"
                                  : "border-border/70 bg-muted/20 text-muted-foreground"
                            }`}
                          >
                            <span>{step.label}</span>
                            <span className="font-mono uppercase tracking-[0.12em]">
                              {step.active ? "running" : step.done ? "done" : "queued"}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {video.analysis ? (
                    <div className="prose prose-invert max-w-none text-sm">
                      <div className="whitespace-pre-wrap break-words">{video.analysis}</div>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground border border-dashed border-border rounded-lg">
                      <BrainCircuit className="h-8 w-8 mb-2 opacity-50" />
                      <p className="font-mono text-xs">No analysis available.</p>
                      {video.status === "completed" && (
                        <Button
                          variant="link"
                          size="sm"
                          className="mt-2 text-primary"
                          onClick={() => analyzeMutation.mutate({ id: video.id })}
                          disabled={analyzeMutation.isPending}
                        >
                          {analyzeMutation.isPending ? "Starting Jack..." : "Generate analysis"}
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
                        className="group flex gap-3 hover:bg-muted/50 active:bg-muted/50 p-3 -mx-2 rounded-lg cursor-pointer transition-colors"
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

      <AlertDialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{isAdmin ? "Delete this video?" : "Remove duplicate video?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {isAdmin
                ? `This permanently removes "${video.title}" and its knowledge-graph node from the Library. This can't be undone.`
                : `This permanently removes your duplicate upload "${video.title}" from the Library. One matching copy must remain.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteMutation.isPending}
              onClick={(e) => {
                e.preventDefault();
                deleteMutation.mutate({ id: video.id });
              }}
            >
              {deleteMutation.isPending ? "Deleting..." : isAdmin ? "Delete" : "Remove duplicate"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </motion.div>
  );
}
