import { motion } from "framer-motion";
import { Play, Clock, Activity, CheckCircle2, AlertCircle } from "lucide-react";
import { Video } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";

interface VideoCardProps {
  video: Video;
  onClick: () => void;
  index: number;
}

export function VideoCard({ video, onClick, index }: VideoCardProps) {
  const getStatusColor = (status: string) => {
    switch (status) {
      case "completed": return "text-emerald-400 bg-emerald-400/10 border-emerald-400/20";
      case "uploading":
      case "uploaded":
      case "transcribing":
      case "analyzing":
      case "indexing":
      case "retrying": return "text-amber-400 bg-amber-400/10 border-amber-400/20";
      case "failed": return "text-destructive bg-destructive/10 border-destructive/20";
      default: return "text-muted-foreground bg-muted border-border";
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "completed": return <CheckCircle2 className="h-3 w-3 mr-1" />;
      case "uploading":
      case "uploaded":
      case "transcribing":
      case "analyzing":
      case "indexing":
      case "retrying": return <Activity className="h-3 w-3 mr-1 animate-pulse" />;
      case "failed": return <AlertCircle className="h-3 w-3 mr-1" />;
      default: return <Clock className="h-3 w-3 mr-1" />;
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.05, duration: 0.3 }}
      onClick={onClick}
      className="group cursor-pointer flex flex-col bg-card rounded-xl border border-card-border overflow-hidden hover:border-primary/50 hover:shadow-[0_0_20px_rgba(255,100,0,0.1)] transition-all duration-300 relative"
    >
      <div className="relative aspect-video bg-muted overflow-hidden">
        {video.thumbnailUrl ? (
          <img src={video.thumbnailUrl} alt={video.title} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-zinc-900 group-hover:scale-105 transition-transform duration-500">
            <Play className="h-12 w-12 text-zinc-800" />
          </div>
        )}
        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
          <div className="w-12 h-12 rounded-full bg-primary/90 flex items-center justify-center text-primary-foreground transform scale-90 group-hover:scale-100 transition-transform">
            <Play className="h-5 w-5 ml-1" />
          </div>
        </div>
        {video.duration && (
          <div className="absolute bottom-2 right-2 bg-black/80 px-2 py-1 rounded text-[10px] font-mono font-medium backdrop-blur-sm">
            {Math.floor(video.duration / 60)}:{(video.duration % 60).toString().padStart(2, '0')}
          </div>
        )}
      </div>

      <div className="p-4 flex flex-col flex-1">
        <div className="flex justify-between items-start mb-2 gap-2">
          <Badge variant="outline" className="font-mono uppercase text-[10px] bg-sidebar border-sidebar-border text-sidebar-foreground">
            {video.trade || "Uncategorized"}
          </Badge>
          <Badge variant="outline" className={`font-mono text-[10px] border ${getStatusColor(video.status)}`}>
            {getStatusIcon(video.status)}
            {video.status}
          </Badge>
        </div>
        
        <h3 className="font-semibold text-lg line-clamp-2 leading-tight mb-2 group-hover:text-primary transition-colors">
          {video.title}
        </h3>
        
        <div className="mt-auto pt-4 flex flex-wrap gap-1">
          {video.competencyCodes?.slice(0, 3).map(code => (
            <span key={code} className="text-[10px] font-mono text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              {code}
            </span>
          ))}
          {(video.competencyCodes?.length || 0) > 3 && (
            <span className="text-[10px] font-mono text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              +{(video.competencyCodes?.length || 0) - 3}
            </span>
          )}
        </div>
      </div>
    </motion.div>
  );
}
