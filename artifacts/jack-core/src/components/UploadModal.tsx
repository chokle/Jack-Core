import { useState, useRef } from "react";
import {
  X,
  UploadCloud,
  FileVideo,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useQueryClient } from "@tanstack/react-query";
import { getListVideosQueryKey } from "@workspace/api-client-react";

interface UploadModalProps {
  onClose: () => void;
}

// Videos larger than this can never be transcribed — the server rejects the
// source before doing any work (see MAX_SOURCE_VIDEO_BYTES). Block them up front
// so they don't upload and then silently fail processing later.
const MAX_FILE_MB = 500;
// How many uploads run at once. The server also caps concurrent processing
// pipelines, so a small client-side pool keeps the UI responsive without
// stampeding the API.
const UPLOAD_CONCURRENCY = 2;

type ItemStatus = "pending" | "uploading" | "done" | "error";

interface UploadItem {
  id: string;
  file: File;
  title: string;
  status: ItemStatus;
  error?: string;
}

function isTooLarge(file: File): boolean {
  return file.size > MAX_FILE_MB * 1024 * 1024;
}

function fileKey(file: File): string {
  return `${file.name.toLowerCase()}::${file.size}::${file.lastModified}`;
}

function isValidationBlocked(item: UploadItem): boolean {
  return isTooLarge(item.file) || item.error === "Already selected in this batch";
}

export function UploadModal({ onClose }: UploadModalProps) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const [trade, setTrade] = useState("");
  const [isUploading, setIsUploading] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  const updateItem = (id: string, patch: Partial<UploadItem>) =>
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files ?? []);
    setItems((prev) => {
      const seen = new Set(prev.map((item) => fileKey(item.file)));
      const additions: UploadItem[] = selected.map((file) => {
        const key = fileKey(file);
        const tooLarge = isTooLarge(file);
        const duplicateInBatch = seen.has(key);
        seen.add(key);
        return {
          id: crypto.randomUUID(),
          file,
          title: file.name.replace(/\.[^.]+$/, ""),
          status: tooLarge || duplicateInBatch ? "error" : "pending",
          error: tooLarge
            ? `Exceeds the ${MAX_FILE_MB} MB transcription limit`
            : duplicateInBatch
              ? "Already selected in this batch"
              : undefined,
        };
      });
      return [...prev, ...additions];
    });
    // Reset so re-selecting the same file(s) still fires onChange.
    e.target.value = "";
  };

  const removeItem = (id: string) => setItems((prev) => prev.filter((it) => it.id !== id));

  const uploadOne = async (item: UploadItem) => {
    const form = new FormData();
    form.append("file", item.file);
    form.append("title", item.title.trim() || item.file.name);
    if (trade) form.append("trade", trade);

    // Session cookie is sent automatically by the browser (httpOnly, sameOrigin).
    const res = await fetch("/api/videos/ingest", {
      method: "POST",
      credentials: "include",
      body: form,
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `Upload failed (${res.status})`);
    }
  };

  const handleUpload = async () => {
    // Everything not yet done and within the size limit (retries oversize files
    // are excluded — they can never succeed).
    const runnable = items.filter(
      (it) => (it.status === "pending" || it.status === "error") && !isValidationBlocked(it),
    );
    if (runnable.length === 0) return;

    setIsUploading(true);
    setItems((prev) =>
      prev.map((it) =>
        runnable.some((r) => r.id === it.id)
          ? { ...it, status: "pending", error: undefined }
          : it,
      ),
    );

    let cursor = 0;
    const worker = async () => {
      while (cursor < runnable.length) {
        const item = runnable[cursor++];
        if (!item) break;
        updateItem(item.id, { status: "uploading", error: undefined });
        try {
          await uploadOne(item);
          updateItem(item.id, { status: "done" });
        } catch (err) {
          updateItem(item.id, {
            status: "error",
            error: err instanceof Error ? err.message : "Upload failed",
          });
        }
        // Keep the Library fresh as each video registers.
        queryClient.invalidateQueries({ queryKey: getListVideosQueryKey() });
      }
    };
    await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, () => worker()));

    setIsUploading(false);
  };

  const doneCount = items.filter((it) => it.status === "done").length;
  const errorCount = items.filter((it) => it.status === "error").length;
  const runnableCount = items.filter(
    (it) => (it.status === "pending" || it.status === "error") && !isValidationBlocked(it),
  ).length;

  const statusIcon = (item: UploadItem) => {
    switch (item.status) {
      case "done":
        return <CheckCircle2 className="h-4 w-4 text-emerald-400" />;
      case "error":
        return <AlertCircle className="h-4 w-4 text-destructive" />;
      case "uploading":
        return <Loader2 className="h-4 w-4 animate-spin text-primary" />;
      default:
        return <FileVideo className="h-4 w-4 text-primary" />;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="bg-card w-full max-w-2xl rounded-xl border border-border shadow-2xl overflow-hidden flex flex-col max-h-[100dvh] sm:max-h-[90vh]">
        <div className="flex justify-between items-center p-4 border-b border-border bg-muted/30">
          <h2 className="font-semibold flex items-center gap-2">
            <UploadCloud className="h-5 w-5 text-primary" />
            Ingest Knowledge
          </h2>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="h-10 w-10 sm:h-8 sm:w-8"
            disabled={isUploading}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="p-6 space-y-4 overflow-y-auto">
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*"
            multiple
            className="hidden"
            onChange={handleFileSelect}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
            className="w-full border-2 border-dashed border-border rounded-lg p-6 flex flex-col items-center justify-center text-muted-foreground bg-muted/20 hover:bg-muted/40 transition-colors cursor-pointer group disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <div className="w-12 h-12 rounded-full bg-background border border-border flex items-center justify-center mb-3 group-hover:scale-110 transition-transform">
              <FileVideo className="h-6 w-6 text-primary" />
            </div>
            <p className="font-medium text-foreground">
              {items.length > 0 ? "Add more videos" : "Select Video Files"}
            </p>
            <p className="text-xs font-mono mt-1">
              Batch upload MP4/MOV files — duplicates are flagged before upload
            </p>
          </button>

          {items.length > 0 && (
            <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
              {items.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center gap-3 rounded-lg border border-border bg-muted/20 p-2.5"
                >
                  <div className="w-8 h-8 rounded-md bg-background border border-border flex items-center justify-center shrink-0">
                    {statusIcon(item)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <Input
                      value={item.title}
                      onChange={(e) => updateItem(item.id, { title: e.target.value })}
                      disabled={isUploading || item.status === "done"}
                      placeholder="Title"
                      className="h-8 bg-background text-sm"
                    />
                    <p className="text-[11px] font-mono text-muted-foreground mt-1 truncate">
                      {(item.file.size / (1024 * 1024)).toFixed(1)} MB
                      {item.error ? (
                        <span className="text-destructive"> • {item.error}</span>
                      ) : null}
                      {item.status === "done" ? (
                        <span className="text-emerald-400"> • queued for processing</span>
                      ) : null}
                    </p>
                  </div>
                  {item.status !== "uploading" && item.status !== "done" && !isUploading && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 sm:h-7 sm:w-7 shrink-0"
                      onClick={() => removeItem(item.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}

          <div>
            <label className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-1 block">
              Trade Category (applied to all)
            </label>
            <Input
              value={trade}
              onChange={(e) => setTrade(e.target.value)}
              disabled={isUploading}
              placeholder="e.g. Electrical, Plumbing"
              className="bg-background"
            />
          </div>
        </div>

        <div className="p-4 pb-[max(1rem,env(safe-area-inset-bottom))] border-t border-border bg-muted/30 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs font-mono text-muted-foreground text-center sm:text-left">
            {items.length} selected
            {doneCount ? ` • ${doneCount} queued` : ""}
            {errorCount ? ` • ${errorCount} failed` : ""}
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              disabled={isUploading}
              className="flex-1 sm:flex-none"
            >
              {doneCount > 0 && runnableCount === 0 ? "Done" : "Cancel"}
            </Button>
            <Button
              type="button"
              onClick={handleUpload}
              disabled={isUploading || runnableCount === 0}
              className="flex-1 sm:flex-none bg-primary text-primary-foreground"
            >
              {isUploading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Uploading...
                </>
              ) : (
                `Upload ${runnableCount} video${runnableCount === 1 ? "" : "s"}`
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
