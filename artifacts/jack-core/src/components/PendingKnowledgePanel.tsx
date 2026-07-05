import { Hourglass, Loader2, User } from "lucide-react";
import {
  useListKnowledgeCandidates,
  getListKnowledgeCandidatesQueryKey,
} from "@workspace/api-client-react";
import type { KnowledgeCandidate } from "@workspace/api-client-react";

/**
 * Read-only visibility into the Knowledge Review queue. Anyone browsing the
 * Living Memory can see which mentor-taught concepts are awaiting Knowledge
 * Review — no resolution controls here (Accept/Merge/Reject stay admin-gated
 * in the Knowledge Review surface).
 *
 * `limit` caps how many rows render (the sidebar shows a compact 6); pass
 * `Infinity` from the full-page Review view so non-admins see the whole queue.
 */
export function PendingKnowledgePanel({ limit = 6 }: { limit?: number } = {}) {
  const candidatesQuery = useListKnowledgeCandidates(
    { status: "pending" },
    {
      query: {
        queryKey: getListKnowledgeCandidatesQueryKey({ status: "pending" }),
        staleTime: 30_000,
      },
    },
  );

  const candidates = candidatesQuery.data?.candidates ?? [];

  return (
    <section className="rounded-xl border border-border bg-card/40 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          Awaiting Knowledge Review
        </h2>
        {candidates.length > 0 && (
          <span className="flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 font-mono text-[10px] font-semibold text-amber-400">
            <Hourglass className="h-3 w-3" />
            {candidates.length}
          </span>
        )}
      </div>

      {candidatesQuery.isLoading ? (
        <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking the queue…
        </div>
      ) : candidatesQuery.isError ? (
        <p className="text-xs text-muted-foreground">
          The Knowledge Review queue isn't available right now.
        </p>
      ) : candidates.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Nothing awaiting Knowledge Review — every mentor-taught concept has
          been placed in the graph.
        </p>
      ) : (
        <>
          <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
            Mentor-taught concepts Jack queued for a reviewer. They aren't lost
            — they join the graph once reviewed.
          </p>
          <ul className="space-y-3">
            {candidates.slice(0, limit).map((cand: KnowledgeCandidate) => (
              <PendingCandidateRow key={cand.id} candidate={cand} />
            ))}
          </ul>
          {candidates.length > limit && (
            <p className="mt-3 text-center font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              +{candidates.length - limit} more in the queue
            </p>
          )}
        </>
      )}
    </section>
  );
}

function PendingCandidateRow({ candidate }: { candidate: KnowledgeCandidate }) {
  const topMatches = candidate.bestMatches.slice(0, 2);
  return (
    <li className="rounded-lg border border-border/70 bg-muted/20 p-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {candidate.title}
        </span>
        <span className="shrink-0 rounded-full border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
          {candidate.category}
        </span>
      </div>
      {candidate.mentorName && (
        <div className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
          <User className="h-3 w-3" /> {candidate.mentorName}
        </div>
      )}
      {topMatches.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {topMatches.map((m) => (
            <span
              key={m.nodeId}
              className="rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300/90"
              title={`Nearly matched "${m.label}"`}
            >
              ≈ {m.label}
              <span className="ml-1 font-mono opacity-70">
                {(m.similarity * 100).toFixed(0)}%
              </span>
            </span>
          ))}
        </div>
      )}
    </li>
  );
}
