import { useState } from "react";
import { Search, Filter, Upload, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useListVideos, useGetVideoStats, useGetRecentVideos, useListCompetencies } from "@workspace/api-client-react";
import { VideoCard } from "./VideoCard";
import { Skeleton } from "@/components/ui/skeleton";
import { motion } from "framer-motion";
import { UploadModal } from "./UploadModal";

interface LibraryProps {
  onSelectVideo: (id: string) => void;
}

export function Library({ onSelectVideo }: LibraryProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTrade, setSelectedTrade] = useState<string | undefined>();
  const [isUploadOpen, setIsUploadOpen] = useState(false);

  const { data: stats } = useGetVideoStats();
  const { data: recentVideos } = useGetRecentVideos();
  const { data: videoList, isLoading } = useListVideos({
    trade: selectedTrade,
  });

  return (
    <div className="flex-1 overflow-y-auto pb-24">
      <div className="max-w-7xl mx-auto px-6 py-8 space-y-8">
        {/* Header & Stats */}
        <div className="flex flex-col md:flex-row gap-6 justify-between items-start md:items-center">
          <div>
            <h1 className="text-4xl font-bold tracking-tight mb-2 text-foreground">Library</h1>
            <p className="text-muted-foreground font-mono text-sm">
              {stats ? `${stats.total} entries indexed • ${Object.keys(stats.byTrade || {}).length} trades covered` : "Loading telemetry..."}
            </p>
          </div>
          <div className="flex gap-3 w-full md:w-auto">
            <div className="relative flex-1 md:w-64">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search knowledge base..."
                className="pl-9 bg-card border-card-border"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <Button onClick={() => setIsUploadOpen(true)} className="bg-primary text-primary-foreground hover:bg-primary/90 shadow-[0_0_15px_rgba(255,100,0,0.3)]">
              <Upload className="h-4 w-4 mr-2" />
              Ingest
            </Button>
          </div>
        </div>

        {/* Recent Videos Row */}
        {recentVideos && recentVideos.length > 0 && !searchQuery && !selectedTrade && (
          <div className="space-y-4">
            <h2 className="text-xl font-semibold flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
              Recently Processed
            </h2>
            <div className="flex gap-4 overflow-x-auto pb-4 scrollbar-hide">
              {recentVideos.map((video, idx) => (
                <div key={video.id} className="min-w-[300px] w-[300px] flex-shrink-0">
                  <VideoCard video={video} onClick={() => onSelectVideo(video.id)} index={idx} />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Main Grid */}
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <h2 className="text-xl font-semibold">All Records</h2>
            <Button variant="outline" size="sm" className="font-mono text-xs">
              <Filter className="h-3 w-3 mr-2" /> Filter
            </Button>
          </div>

          {isLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <div key={i} className="space-y-3">
                  <Skeleton className="h-48 w-full rounded-lg bg-card-border" />
                  <Skeleton className="h-4 w-2/3 bg-card-border" />
                  <Skeleton className="h-4 w-1/3 bg-card-border" />
                </div>
              ))}
            </div>
          ) : videoList?.videos.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 text-center border border-dashed border-card-border rounded-xl bg-card/30">
              <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-4">
                <Info className="h-6 w-6 text-muted-foreground" />
              </div>
              <h3 className="text-lg font-medium">No records found</h3>
              <p className="text-muted-foreground max-w-sm mt-1 mb-6">
                The intelligence engine is empty. Ingest videos to begin processing trade knowledge.
              </p>
              <Button onClick={() => setIsUploadOpen(true)} variant="outline">
                Ingest First Video
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {videoList?.videos.filter(v => 
                !searchQuery || v.title.toLowerCase().includes(searchQuery.toLowerCase())
              ).map((video, idx) => (
                <VideoCard key={video.id} video={video} onClick={() => onSelectVideo(video.id)} index={idx} />
              ))}
            </div>
          )}
        </div>
      </div>

      {isUploadOpen && <UploadModal onClose={() => setIsUploadOpen(false)} />}
    </div>
  );
}
