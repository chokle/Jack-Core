import { useState } from "react";
import { Bookmark, Loader2, PlayCircle, Archive, Clock } from "lucide-react";
import {
  useParkThought,
  useListParkedThoughts,
  useResumeParkedThought,
  useArchiveParkedThought,
  getListParkedThoughtsQueryKey,
} from "@workspace/api-client-react";
import type { ParkedThought } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";
import { timeAgo } from "@/lib/memory-graph";

export type ParkContextItem = { role: "user" | "assistant"; text: string };

/**
 * Resuming a parked INTERVIEW thought routes through the same
 * `onResumeInterview(sessionId)` plumbing as the mentor-node "Resume
 * Interview" action, which only knows a session id — it has no way to also
 * carry "why was this parked". Stashing that context in localStorage here
 * (read once by InterviewMode, then cleared) lets the interview screen show
 * a reorientation banner without threading extra props through App.tsx.
 */
const INTERVIEW_RESUME_NOTE_KEY = "jack.interview.resumeNote";

export function stashInterviewResumeNote(thought: ParkedThought) {
  if (!thought.interviewSessionId) return;
  try {
    localStorage.setItem(
      INTERVIEW_RESUME_NOTE_KEY,
      JSON.stringify({
        sessionId: thought.interviewSessionId,
        reason: thought.reason ?? null,
        unfinishedThought: thought.unfinishedThought ?? null,
        createdAt: thought.createdAt,
      }),
    );
  } catch {
    // Storage unavailable — banner just won't show, resume still works.
  }
}

export interface InterviewResumeNote {
  sessionId: string;
  reason: string | null;
  unfinishedThought: string | null;
  createdAt: string;
}

/** Reads and clears the note — it's meant to surface exactly once. */
export function consumeInterviewResumeNote(sessionId: string): InterviewResumeNote | null {
  try {
    const raw = localStorage.getItem(INTERVIEW_RESUME_NOTE_KEY);
    if (!raw) return null;
    localStorage.removeItem(INTERVIEW_RESUME_NOTE_KEY);
    const parsed = JSON.parse(raw) as InterviewResumeNote;
    return parsed.sessionId === sessionId ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * "Park This Thought" — captures a lightweight snapshot of an in-progress
 * conversation (last ≤5 messages, whatever's unfinished, an optional reason)
 * so it can be picked back up later. No AI call — a deterministic bookmark,
 * not a new knowledge write.
 */
export function ParkThisThoughtButton({
  source,
  interviewSessionId,
  context,
  topic,
  category,
  disabled,
  className,
  onParked,
}: {
  source: "chat" | "interview";
  interviewSessionId?: string;
  context: ParkContextItem[];
  topic?: string;
  category?: string;
  disabled?: boolean;
  className?: string;
  onParked?: (thought: ParkedThought) => void;
}) {
  const [open, setOpen] = useState(false);
  const [unfinishedThought, setUnfinishedThought] = useState("");
  const [reason, setReason] = useState("");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const parkThought = useParkThought({
    mutation: {
      onSuccess: (data) => {
        setOpen(false);
        setUnfinishedThought("");
        setReason("");
        queryClient.invalidateQueries({
          queryKey: getListParkedThoughtsQueryKey().slice(0, 1),
        });
        toast({
          title: "Thought parked",
          description: "Find it in your Parking Lot to pick back up later.",
        });
        onParked?.(data);
      },
      onError: () => {
        toast({
          title: "Couldn't park that thought",
          description: "Please try again in a moment.",
          variant: "destructive",
        });
      },
    },
  });

  const handleSave = () => {
    parkThought.mutate({
      data: {
        source,
        interviewSessionId: source === "interview" ? interviewSessionId ?? null : null,
        context: context.slice(-5).map((c) => ({ role: c.role, text: c.text })),
        unfinishedThought: unfinishedThought.trim() || null,
        reason: reason.trim() || null,
        topic: source === "chat" ? topic ?? null : null,
        category: source === "chat" ? category ?? null : null,
      },
    });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          className={className}
        >
          <Bookmark className="h-3.5 w-3.5" />
          Park This Thought
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <div className="space-y-3">
          <div>
            <h4 className="text-sm font-semibold text-foreground">Park this thought</h4>
            <p className="text-xs text-muted-foreground">
              Save where you are so you can pick it back up later.
            </p>
          </div>
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-muted-foreground">
              What's unfinished? (optional)
            </label>
            <Textarea
              value={unfinishedThought}
              onChange={(e) => setUnfinishedThought(e.target.value.slice(0, 2000))}
              placeholder="e.g. still need to confirm the derating factor"
              className="min-h-16 text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-muted-foreground">
              Why park it? (optional)
            </label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value.slice(0, 500))}
              placeholder="e.g. need to check the panel spec first"
              className="min-h-12 text-sm"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={handleSave} disabled={parkThought.isPending}>
              {parkThought.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Bookmark className="h-3.5 w-3.5" />
              )}
              Park it
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Shared "Parking Lot" list — the ONE component backing all three surfaces
 * (Living Memory sidebar, a mentor node's detail panel, the interview
 * screen). Only "parked" items are shown; resuming or archiving removes an
 * item from view via query invalidation, so there's no separate history tab
 * to maintain.
 */
export function ParkedThoughtsList({
  mentorProfileId,
  title = "Parking Lot",
  emptyMessage = "Nothing parked right now.",
  limit,
  onResumeChat,
  onResumeInterview,
  className,
}: {
  mentorProfileId?: string;
  title?: string;
  emptyMessage?: string;
  limit?: number;
  onResumeChat: (thought: ParkedThought) => void;
  onResumeInterview: (sessionId: string) => void;
  className?: string;
}) {
  const params = { status: "parked" as const, ...(mentorProfileId ? { mentorProfileId } : {}) };
  const query = useListParkedThoughts(params, {
    query: { queryKey: getListParkedThoughtsQueryKey(params), staleTime: 15_000 },
  });
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListParkedThoughtsQueryKey(params) });
  };

  const resumeMutation = useResumeParkedThought({
    mutation: {
      onSuccess: (thought) => {
        invalidate();
        if (thought.source === "interview" && thought.interviewSessionId) {
          stashInterviewResumeNote(thought);
          onResumeInterview(thought.interviewSessionId);
        } else {
          onResumeChat(thought);
        }
      },
      onError: () => {
        toast({
          title: "Couldn't resume that thought",
          description: "Please try again in a moment.",
          variant: "destructive",
        });
      },
    },
  });

  const archiveMutation = useArchiveParkedThought({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Archived" });
      },
      onError: () => {
        toast({
          title: "Couldn't archive that thought",
          description: "Please try again in a moment.",
          variant: "destructive",
        });
      },
    },
  });

  const items = (query.data?.items ?? []).slice(0, limit);

  return (
    <section className={className}>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          {title}
        </h2>
        {items.length > 0 && (
          <span className="rounded-full bg-primary/15 px-2 py-0.5 font-mono text-[10px] font-semibold text-primary">
            {items.length}
          </span>
        )}
      </div>

      {query.isLoading ? (
        <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </div>
      ) : query.isError ? (
        <p className="text-xs text-muted-foreground">The Parking Lot isn't available right now.</p>
      ) : items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyMessage}</p>
      ) : (
        <ul className="space-y-2.5">
          {items.map((thought) => (
            <li
              key={thought.id}
              className="rounded-lg border border-border/70 bg-muted/20 p-2.5"
            >
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0 flex-1 text-sm font-medium leading-snug text-foreground">
                  {thought.title}
                </span>
              </div>
              <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                {thought.summary}
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <span className="flex items-center gap-1 text-[10px] text-muted-foreground/80">
                  <Clock className="h-3 w-3" /> {timeAgo(thought.createdAt)}
                </span>
                {thought.trade && (
                  <span className="rounded-full border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                    {thought.trade}
                  </span>
                )}
                {thought.reason && (
                  <span
                    className="truncate rounded-full border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                    title={thought.reason}
                  >
                    {thought.reason}
                  </span>
                )}
              </div>
              <div className="mt-2 flex justify-end gap-1.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                  disabled={archiveMutation.isPending}
                  onClick={() => archiveMutation.mutate({ id: thought.id })}
                >
                  <Archive className="h-3 w-3" /> Archive
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  disabled={resumeMutation.isPending}
                  onClick={() => resumeMutation.mutate({ id: thought.id })}
                >
                  <PlayCircle className="h-3 w-3" /> Resume
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
