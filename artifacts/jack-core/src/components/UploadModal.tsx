import { useState } from "react";
import { X, UploadCloud, FileVideo } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useCreateVideo } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { getListVideosQueryKey } from "@workspace/api-client-react";

interface UploadModalProps {
  onClose: () => void;
}

export function UploadModal({ onClose }: UploadModalProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [trade, setTrade] = useState("");
  
  const createMutation = useCreateVideo();
  const queryClient = useQueryClient();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    createMutation.mutate(
      { data: { title, description, trade, tags: [] } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListVideosQueryKey() });
          onClose();
        }
      }
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="bg-card w-full max-w-md rounded-xl border border-border shadow-2xl overflow-hidden flex flex-col">
        <div className="flex justify-between items-center p-4 border-b border-border bg-muted/30">
          <h2 className="font-semibold flex items-center gap-2">
            <UploadCloud className="h-5 w-5 text-primary" />
            Ingest Knowledge
          </h2>
          <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8">
            <X className="h-4 w-4" />
          </Button>
        </div>
        
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div className="border-2 border-dashed border-border rounded-lg p-8 flex flex-col items-center justify-center text-muted-foreground bg-muted/20 hover:bg-muted/40 transition-colors cursor-pointer group">
            <div className="w-12 h-12 rounded-full bg-background border border-border flex items-center justify-center mb-3 group-hover:scale-110 transition-transform">
              <FileVideo className="h-6 w-6 text-primary" />
            </div>
            <p className="font-medium text-foreground">Select Video File</p>
            <p className="text-xs font-mono mt-1">MP4, MOV up to 2GB</p>
          </div>

          <div className="space-y-3">
            <div>
              <label className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-1 block">Title</label>
              <Input 
                value={title} 
                onChange={(e) => setTitle(e.target.value)} 
                required 
                placeholder="e.g. HVAC Wiring Basics"
                className="bg-background"
              />
            </div>
            <div>
              <label className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-1 block">Trade Category</label>
              <Input 
                value={trade} 
                onChange={(e) => setTrade(e.target.value)} 
                placeholder="e.g. Electrical, Plumbing"
                className="bg-background"
              />
            </div>
            <div>
              <label className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-1 block">Description (Optional)</label>
              <Textarea 
                value={description} 
                onChange={(e) => setDescription(e.target.value)} 
                placeholder="Brief context about this video..."
                className="bg-background resize-none h-20"
              />
            </div>
          </div>

          <div className="pt-4 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={createMutation.isPending || !title} className="bg-primary text-primary-foreground">
              {createMutation.isPending ? "Ingesting..." : "Upload & Register"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
