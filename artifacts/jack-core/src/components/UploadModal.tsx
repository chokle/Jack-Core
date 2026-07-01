import { useState, useRef } from "react";
import { X, UploadCloud, FileVideo, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useQueryClient } from "@tanstack/react-query";
import { getListVideosQueryKey } from "@workspace/api-client-react";

interface UploadModalProps {
  onClose: () => void;
}

export function UploadModal({ onClose }: UploadModalProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [trade, setTrade] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0] ?? null;
    setFile(selected);
    if (selected && !title) {
      setTitle(selected.name.replace(/\.[^.]+$/, ""));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file || !title || isUploading) return;

    setError(null);
    setIsUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("title", title);
      if (description) form.append("description", description);
      if (trade) form.append("trade", trade);

      // Session cookie is sent automatically by the browser (httpOnly, sameOrigin).
      // No credentials are embedded in the bundle.
      const res = await fetch("/api/videos/ingest", {
        method: "POST",
        credentials: "include",
        body: form,
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Upload failed (${res.status})`);
      }

      queryClient.invalidateQueries({ queryKey: getListVideosQueryKey() });
      onClose();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Upload failed. Please try again.",
      );
      setIsUploading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="bg-card w-full max-w-md rounded-xl border border-border shadow-2xl overflow-hidden flex flex-col">
        <div className="flex justify-between items-center p-4 border-b border-border bg-muted/30">
          <h2 className="font-semibold flex items-center gap-2">
            <UploadCloud className="h-5 w-5 text-primary" />
            Ingest Knowledge
          </h2>
          <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8" disabled={isUploading}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*"
            className="hidden"
            onChange={handleFileSelect}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="w-full border-2 border-dashed border-border rounded-lg p-8 flex flex-col items-center justify-center text-muted-foreground bg-muted/20 hover:bg-muted/40 transition-colors cursor-pointer group"
          >
            <div className="w-12 h-12 rounded-full bg-background border border-border flex items-center justify-center mb-3 group-hover:scale-110 transition-transform">
              <FileVideo className="h-6 w-6 text-primary" />
            </div>
            {file ? (
              <>
                <p className="font-medium text-foreground break-all px-2 text-center">{file.name}</p>
                <p className="text-xs font-mono mt-1">
                  {(file.size / (1024 * 1024)).toFixed(1)} MB • click to change
                </p>
              </>
            ) : (
              <>
                <p className="font-medium text-foreground">Select Video File</p>
                <p className="text-xs font-mono mt-1">MP4, MOV up to 2GB</p>
              </>
            )}
          </button>

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

          {error && (
            <p className="text-sm text-destructive font-mono bg-destructive/10 border border-destructive/30 rounded px-3 py-2">
              {error}
            </p>
          )}

          <div className="pt-4 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose} disabled={isUploading}>Cancel</Button>
            <Button type="submit" disabled={isUploading || !title || !file} className="bg-primary text-primary-foreground">
              {isUploading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Uploading...
                </>
              ) : (
                "Upload & Register"
              )}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
