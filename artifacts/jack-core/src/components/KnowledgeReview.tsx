import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  GitMerge,
  XCircle,
  Loader2,
  Inbox,
  Search,
  ShieldCheck,
  User,
  Archive,
  RotateCcw,
} from "lucide-react";
import { motion } from "framer-motion";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useListKnowledgeCandidates,
  useResolveKnowledgeCandidate,
  useGetGraph,
  useGetMentorContributions,
  useGetMe,
  getListKnowledgeCandidatesQueryKey,
  getGetGraphQueryKey,
  getGetMentorContributionsQueryKey,
} from "@workspace/api-client-react";
import type {
  KnowledgeCandidate,
  KnowledgeNode,
  ListKnowledgeCandidatesStatus,
  MentorContribution,
} from "@workspace/api-client-react";
import { PendingKnowledgePanel } from "./PendingKnowledgePanel";
import { MentorContributions } from "./MentorContributions";
import { MentorWithdrawal } from "./MentorWithdrawal";
import { GraphHealth } from "./GraphHealth";
import { useToast } from "@/hooks/use-toast";

/** Scaffold kinds that can never be a merge target. */
const SCAFFOLD_KINDS = new Set(["core", "topic", "competency", "video", "mentor"]);

const STATUS_TABS: { value: ListKnowledgeCandidatesStatus; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "accepted", label: "Accepted" },
  { value: "merged", label: "Merged" },
  { value: "rejected", label: "Rejected" },
  { value: "archived", label: "Archived" },
  { value: "restored", label: "Restored" },
];

/** How the candidate list is ordered relative to each mentor's track record. */
type MentorSort = "queue" | "trusted" | "risky";

const MENTOR_SORTS: { value: MentorSort; label: string; title: string }[] = [
  { value: "queue", label: "Queue order", title: "Newest-first, as Jack queued them" },
  {
    value: "trusted",
    label: "Trusted mentors first",
    title: "Mentors with the most accepted contributions at the top",
  },
  {
    value: "risky",
    label: "Low-trust first",
    title: "Mentors with the most rejected contributions at the top",
  },
];

/**
 * Order candidates by their mentor's track record without mutating the source
 * list. `queue` preserves the server order. `trusted` floats mentors with the
 * most accepted contributions to the top; `risky` floats the most-rejected
 * mentors. Candidates whose mentor is unknown (no contribution row, or no
 * mentorProfileId) always sink to the bottom so they never crowd out a
 * signal-carrying card, and ties fall back to the original queue position for a
 * stable order.
 */
function sortCandidatesByMentor(
  candidates: KnowledgeCandidate[],
  contributionByMentor: Map<string, MentorContribution>,
  sort: MentorSort,
): KnowledgeCandidate[] {
  if (sort === "queue") return candidates;
  const contributionFor = (c: KnowledgeCandidate) =>
    c.mentorProfileId ? contributionByMentor.get(c.mentorProfileId) ?? null : null;
  // Primary signal per mode; unknown mentors score below any real mentor.
  const score = (contribution: MentorContribution | null) => {
    if (!contribution) return -1;
    return sort === "trusted" ? contribution.accepted : contribution.rejected;
  };
  return candidates
    .map((candidate, index) => ({ candidate, index, contribution: contributionFor(candidate) }))
    .sort((a, b) => {
      const diff = score(b.contribution) - score(a.contribution);
      if (diff !== 0) return diff;
      // Tiebreak on the opposing signal so a cleaner record wins within a bucket.
      const aOther = a.contribution
        ? sort === "trusted"
          ? a.contribution.rejected
          : a.contribution.accepted
        : 0;
      const bOther = b.contribution
        ? sort === "trusted"
          ? b.contribution.rejected
          : b.contribution.accepted
        : 0;
      const otherDiff = sort === "trusted" ? aOther - bOther : bOther - aOther;
      if (otherDiff !== 0) return otherDiff;
      return a.index - b.index;
    })
    .map((entry) => entry.candidate);
}

/** Where each resolution action lands a card, so the success toast can tell the
 *  reviewer which tab to find it under. */
const ACTION_DESTINATION: Record<string, { label: string }> = {
  accept: { label: "Accepted" },
  merge: { label: "Merged" },
  reject: { label: "Rejected" },
  reopen: { label: "Pending" },
  restore: { label: "Restored" },
  rearchive: { label: "Archived" },
};

export function KnowledgeReview() {
  // Admin status comes from the signed-in user's email allowlist (resolved
  // server-side via GET /me). Every mutating review route is independently
  // enforced with requireAdmin on the server; hiding the controls here is
  // defense-in-depth, not the security boundary. Keep `null` while loading so
  // we don't flash the non-admin view to a real admin.
  const meQuery = useGetMe();
  const isAdmin: boolean | null = meQuery.isLoading
    ? null
    : (meQuery.data?.isAdmin ?? false);

  const [statusTab, setStatusTab] = useState<ListKnowledgeCandidatesStatus>("pending");
  const [mentorSort, setMentorSort] = useState<MentorSort>("queue");
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const candidatesQuery = useListKnowledgeCandidates(
    { status: statusTab },
    {
      query: {
        enabled: isAdmin === true,
        queryKey: getListKnowledgeCandidatesQueryKey({ status: statusTab }),
      },
    },
  );
  const graphQuery = useGetGraph({
    query: { enabled: isAdmin === true, queryKey: getGetGraphQueryKey() },
  });
  const contributionsQuery = useGetMentorContributions({
    request: { credentials: "include" },
    query: { enabled: isAdmin === true, queryKey: getGetMentorContributionsQueryKey() },
  });

  // mentorProfileId → contribution track record, so each card can show the
  // mentor's overall footprint without an extra per-card request.
  const contributionByMentor = useMemo(() => {
    const map = new Map<string, MentorContribution>();
    for (const c of contributionsQuery.data?.contributions ?? []) {
      map.set(c.mentorProfileId, c);
    }
    return map;
  }, [contributionsQuery.data]);

  const conceptNodes = useMemo(
    () => (graphQuery.data?.nodes ?? []).filter((n) => !SCAFFOLD_KINDS.has(n.kind)),
    [graphQuery.data],
  );

  // Resolve a stored node id (e.g. `k:concept:...`) to its human label. Includes
  // scaffold nodes too, since a resolution can point at a competency/topic hub.
  const nodeLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const n of graphQuery.data?.nodes ?? []) map.set(n.id, n.label);
    return map;
  }, [graphQuery.data]);

  // When a resolve is refused because the target vanished (code=target_gone),
  // the candidate stays pending — remember which card hit it so it can open
  // the merge picker with an explanation.
  const [goneCandidateId, setGoneCandidateId] = useState<string | null>(null);

  const resolve = useResolveKnowledgeCandidate({
    request: { credentials: "include" },
    mutation: {
      onSuccess: (_data, variables) => {
        setGoneCandidateId(null);
        // Invalidate the whole candidates key (prefix-matches every status tab)
        // plus the mentor track record and graph, so the resolved card leaves
        // this tab AND is fresh under its destination tab without a manual reload.
        void queryClient.invalidateQueries({ queryKey: getListKnowledgeCandidatesQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getGetMentorContributionsQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getGetGraphQueryKey() });
        const dest = ACTION_DESTINATION[variables.data.action];
        if (dest) {
          toast({ title: dest.label, description: `Moved to the ${dest.label} tab.` });
        }
      },
      onError: (error, variables) => {
        const body = (error as { data?: { code?: string; error?: string } | null }).data;
        if (body?.code === "target_gone") {
          setGoneCandidateId(variables.id);
          // Refresh the listing so match chips show current validity.
          void queryClient.invalidateQueries({ queryKey: getListKnowledgeCandidatesQueryKey() });
          return;
        }
        toast({
          variant: "destructive",
          title: "Couldn't complete that action",
          description: body?.error ?? "The candidate may have already been resolved elsewhere.",
        });
      },
    },
  });

  if (isAdmin === false) {
    return (
      <div className="flex flex-1 flex-col overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-4 py-8 md:px-8">
          <div className="mb-1 flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            <h1 className="text-xl font-bold tracking-tight">Knowledge Review</h1>
          </div>
          <p className="mb-6 text-sm text-muted-foreground">
            These mentor-taught concepts are waiting for a reviewer to place them
            in the Living Memory. You can follow the queue below — accepting,
            merging, or rejecting entries is limited to administrators.
          </p>

          <PendingKnowledgePanel limit={Infinity} />
        </div>
      </div>
    );
  }

  const candidates = candidatesQuery.data?.candidates ?? [];
  const sortedCandidates = sortCandidatesByMentor(
    candidates,
    contributionByMentor,
    mentorSort,
  );

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl px-4 py-8 md:px-8">
        <div className="mb-1 flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-bold tracking-tight">Knowledge Review</h1>
        </div>
        <p className="mb-6 text-sm text-muted-foreground">
          Mentor-taught concepts Jack wasn't sure about. Accept to reinforce the
          suggested match, merge into a concept you choose, or reject with a reason.
          The Archived tab holds knowledge demoted when a mentor was withdrawn —
          restore it to bring it back as unverified knowledge, or re-archive a
          restore from the Restored tab if it was a mistake.
        </p>

        {/* Status tabs */}
        <div className="mb-6 flex flex-wrap gap-1.5">
          {STATUS_TABS.map((t) => (
            <button
              key={t.value}
              onClick={() => setStatusTab(t.value)}
              className={`rounded-lg px-3 py-2 md:py-1.5 text-xs font-semibold transition-colors ${
                statusTab === t.value
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Order the queue by mentor track record so a reviewer can triage
            trusted vs. low-trust mentors first. Only shown when there's a
            multi-card list to reorder. */}
        {candidates.length > 1 && (
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Sort by mentor
            </span>
            <div className="flex flex-wrap gap-1.5">
              {MENTOR_SORTS.map((s) => (
                <button
                  key={s.value}
                  onClick={() => setMentorSort(s.value)}
                  title={s.title}
                  className={`rounded-lg px-2.5 py-1.5 md:py-1 text-xs font-medium transition-colors ${
                    mentorSort === s.value
                      ? "bg-primary/15 text-primary"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {isAdmin === null || candidatesQuery.isLoading ? (
          <div className="flex items-center justify-center py-20 text-muted-foreground">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading…
          </div>
        ) : candidatesQuery.isError ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
            Could not load candidates. The knowledge queue table may not be applied yet.
          </div>
        ) : candidates.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border py-16 text-muted-foreground">
            <Inbox className="h-8 w-8" />
            <div className="text-sm">
              {statusTab === "pending"
                ? "Nothing waiting for review — the queue is clear."
                : `No ${statusTab} candidates yet.`}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {sortedCandidates.map((cand, idx) => (
              <motion.div
                key={cand.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(idx * 0.04, 0.3) }}
              >
                <CandidateCard
                  candidate={cand}
                  conceptNodes={conceptNodes}
                  nodeLabelById={nodeLabelById}
                  mentorContribution={
                    cand.mentorProfileId
                      ? contributionByMentor.get(cand.mentorProfileId) ?? null
                      : null
                  }
                  busy={resolve.isPending}
                  targetGone={goneCandidateId === cand.id}
                  onResolve={(action, extra) =>
                    resolve.mutate({ id: cand.id, data: { action, ...extra } })
                  }
                />
              </motion.div>
            ))}
          </div>
        )}

        {isAdmin === true && <MentorContributions />}
        {isAdmin === true && <MentorWithdrawal />}
        {isAdmin === true && <GraphHealth />}
      </div>
    </div>
  );
}

/**
 * A mentor's overall footprint, shown under their name on a candidate card so a
 * reviewer can weigh a borderline candidate against the mentor's track record:
 * how many live concepts they created or reinforced, and how their prior
 * candidates were resolved. All counts are read-only aggregations from the
 * server — nothing here mutates the graph.
 */
function MentorTrackRecord({ contribution }: { contribution: MentorContribution }) {
  const { conceptsCreated, conceptsReinforced, accepted, rejected, pending } = contribution;
  const conceptTotal = conceptsCreated + conceptsReinforced;
  return (
    <div
      className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground/90"
      title="This mentor's overall contribution across the Living Memory"
    >
      <span className="font-mono uppercase tracking-[0.14em] text-muted-foreground/70">
        Track record
      </span>
      <span title="Live concepts this mentor sources">
        <span className="font-semibold text-foreground">{conceptTotal}</span> concept
        {conceptTotal === 1 ? "" : "s"}
        {conceptTotal > 0 && (
          <span className="text-muted-foreground/70">
            {" "}
            ({conceptsCreated} created · {conceptsReinforced} reinforced)
          </span>
        )}
      </span>
      <span className="text-emerald-400/90" title="Prior candidates accepted or merged">
        {accepted} accepted
      </span>
      <span className="text-red-400/90" title="Prior candidates rejected">
        {rejected} rejected
      </span>
      {pending > 0 && (
        <span className="text-amber-400/90" title="Candidates still awaiting review">
          {pending} pending
        </span>
      )}
    </div>
  );
}

function CandidateCard({
  candidate,
  conceptNodes,
  nodeLabelById,
  mentorContribution,
  busy,
  targetGone,
  onResolve,
}: {
  candidate: KnowledgeCandidate;
  conceptNodes: KnowledgeNode[];
  /** Node id → human label, for rendering resolution targets by name. */
  nodeLabelById: Map<string, string>;
  /** This candidate's mentor's overall track record, or null if unknown. */
  mentorContribution: MentorContribution | null;
  busy: boolean;
  /** The last resolve attempt failed because the target vanished — open the merge picker. */
  targetGone: boolean;
  onResolve: (
    action: "accept" | "merge" | "reject" | "restore" | "rearchive" | "reopen",
    extra?: { targetNodeId?: string; reason?: string },
  ) => void;
}) {
  const [mode, setMode] = useState<"idle" | "merge" | "reject">("idle");
  const [mergeSearch, setMergeSearch] = useState("");
  const [mergeTarget, setMergeTarget] = useState<KnowledgeNode | null>(null);
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (targetGone) setMode("merge");
  }, [targetGone]);

  const topMatch = candidate.bestMatches[0];
  const topMatchGone = topMatch?.validity === "gone";
  const isPending = candidate.status === "pending";
  const isArchived = candidate.status === "archived";
  const isRestored = candidate.status === "restored";
  const isRejected = candidate.status === "rejected";
  const isAccepted = candidate.status === "accepted";
  const isMerged = candidate.status === "merged";

  const mergeMatches = useMemo(() => {
    const q = mergeSearch.trim().toLowerCase();
    if (!q) return conceptNodes.slice(0, 8);
    return conceptNodes
      .filter((n) => n.label.toLowerCase().includes(q))
      .slice(0, 8);
  }, [conceptNodes, mergeSearch]);

  const resolvedLabel =
    candidate.status === "accepted"
      ? "Accepted"
      : candidate.status === "merged"
        ? "Merged"
        : candidate.status === "rejected"
          ? "Rejected"
          : candidate.status === "archived"
            ? "Archived"
            : candidate.status === "restored"
              ? "Restored"
              : null;

  return (
    <div className="rounded-xl border border-border bg-card/60 p-4 backdrop-blur-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">{candidate.title}</h3>
            <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              {candidate.category}
            </span>
            {candidate.trade && (
              <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                {candidate.trade}
              </span>
            )}
            {resolvedLabel && (
              <span
                className={`rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
                  candidate.status === "rejected"
                    ? "bg-red-500/15 text-red-400"
                    : candidate.status === "merged"
                      ? "bg-amber-500/15 text-amber-400"
                      : candidate.status === "archived"
                        ? "bg-muted/60 text-muted-foreground"
                        : "bg-emerald-500/15 text-emerald-400"
                }`}
              >
                {resolvedLabel}
              </span>
            )}
          </div>
          {candidate.description && (
            <p className="mt-1 text-sm text-muted-foreground">{candidate.description}</p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {candidate.mentorName && (
              <span className="flex items-center gap-1">
                <User className="h-3 w-3" /> {candidate.mentorName}
              </span>
            )}
            {typeof candidate.confidence === "number" && (
              <span className="font-mono">
                confidence {(candidate.confidence * 100).toFixed(0)}%
              </span>
            )}
          </div>
          {mentorContribution && candidate.mentorName && (
            <MentorTrackRecord contribution={mentorContribution} />
          )}
        </div>
      </div>

      {/* Best matches */}
      {candidate.bestMatches.length > 0 && (
        <div className="mt-3 space-y-1">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Closest existing concepts
          </div>
          <div className="flex flex-wrap gap-1.5">
            {candidate.bestMatches.map((m, i) => (
              <span
                key={m.nodeId}
                className={`rounded-lg border px-2 py-1 text-xs ${
                  m.validity === "gone"
                    ? "border-border/60 bg-muted/20 text-muted-foreground/60"
                    : i === 0
                      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                      : "border-border bg-muted/30 text-muted-foreground"
                }`}
              >
                <span className={m.validity === "gone" ? "line-through" : undefined}>
                  {m.label}
                </span>
                <span className="ml-1.5 font-mono opacity-70">
                  {(m.similarity * 100).toFixed(0)}%
                </span>
                {m.validity === "redirected" && m.currentLabel && (
                  <span className="ml-1.5 text-amber-300">
                    → now part of “{m.currentLabel}”
                  </span>
                )}
                {m.validity === "gone" && (
                  <span className="ml-1.5 italic">no longer exists</span>
                )}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Resolution details for already-resolved rows */}
      {!isPending && (
        <div className="mt-3 text-xs text-muted-foreground">
          {candidate.status === "rejected" && candidate.resolutionReason && (
            <span>Reason: {candidate.resolutionReason}</span>
          )}
          {isArchived && (
            <span className="flex items-center gap-1.5">
              <Archive className="h-3 w-3" />
              Demoted out of the live graph when its mentor was withdrawn.
              Restore to bring it back as unverified knowledge.
            </span>
          )}
          {isRestored && (
            <span className="flex items-center gap-1.5">
              <RotateCcw className="h-3 w-3" />
              Re-minted into the live graph as unverified curated knowledge.
              Re-archive it if this restore was a mistake.
            </span>
          )}
          {candidate.status !== "rejected" && !isArchived && !isRestored && candidate.resolvedTargetId && (
            (() => {
              const resolvedId = candidate.resolvedTargetId;
              const requestedId = candidate.requestedTargetId;
              const resolvedName = nodeLabelById.get(resolvedId) ?? resolvedId;
              const wasRedirected =
                !!requestedId && requestedId !== resolvedId;
              const requestedName = requestedId
                ? nodeLabelById.get(requestedId) ?? requestedId
                : null;
              return (
                <div className="flex flex-wrap items-center gap-1.5">
                  {wasRedirected && requestedName && (
                    <>
                      <span>Requested</span>
                      <span className="rounded-md border border-border/60 bg-muted/30 px-1.5 py-0.5 text-muted-foreground/80 line-through">
                        {requestedName}
                      </span>
                      <span className="text-amber-400/90">→</span>
                    </>
                  )}
                  <span>{wasRedirected ? "landed in" : "Reinforced"}</span>
                  <span className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-emerald-300">
                    {resolvedName}
                  </span>
                  {candidate.redirectReason && (
                    <span className="text-amber-400/90">
                      ({candidate.redirectReason})
                    </span>
                  )}
                </div>
              );
            })()
          )}
        </div>
      )}

      {/* Restore action for archived (mentor-withdrawn) knowledge */}
      {isArchived && (
        <div className="mt-4 border-t border-border/70 pt-3">
          <Button
            size="sm"
            disabled={busy}
            onClick={() => onResolve("restore")}
            className="min-h-10 md:min-h-8 bg-emerald-600 text-white hover:bg-emerald-500"
            title="Re-mint this concept as attribution-free unverified knowledge"
          >
            <RotateCcw className="mr-1.5 h-4 w-4" />
            Restore knowledge
          </Button>
        </div>
      )}

      {/* Undo a restore: demote the curated concept back to archived */}
      {isRestored && (
        <div className="mt-4 border-t border-border/70 pt-3">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => onResolve("rearchive")}
            className="min-h-10 md:min-h-8"
            title="Undo this restore — move the concept back to archived knowledge"
          >
            <Archive className="mr-1.5 h-4 w-4" />
            Re-archive
          </Button>
        </div>
      )}

      {/* Reopen a resolved candidate: return it to the pending queue for a fresh
          decision. For accepted/merged this also UNDOES the reinforcement —
          the server drops this answer's mentor→concept provenance edge and
          reconverges the concept's confidence. Hidden when the mentor was
          withdrawn (provenance scrubbed), since reopen would strand a candidate
          accept/merge can no longer use. */}
      {(isRejected || isAccepted || isMerged) && candidate.mentorProfileId && (
        <div className="mt-4 border-t border-border/70 pt-3">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => onResolve("reopen")}
            className="min-h-10 md:min-h-8"
            title={
              isRejected
                ? "Undo this rejection — return the candidate to the pending queue for a fresh decision"
                : "Undo this reinforcement — remove the lesson from the knowledge graph and return the candidate to pending"
            }
          >
            <RotateCcw className="mr-1.5 h-4 w-4" />
            {isRejected ? "Reopen for review" : "Undo & reopen"}
          </Button>
        </div>
      )}

      {/* Actions */}
      {isPending && (
        <div className="mt-4 border-t border-border/70 pt-3">
          {mode === "idle" && (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={busy || !topMatch || topMatchGone}
                onClick={() => onResolve("accept")}
                className="min-h-10 md:min-h-8 bg-emerald-600 text-white hover:bg-emerald-500"
                title={
                  !topMatch
                    ? "No suggested match — use merge instead"
                    : topMatchGone
                      ? "The suggested match no longer exists — use merge instead"
                      : `Reinforce “${topMatch.currentLabel ?? topMatch.label}”`
                }
              >
                <CheckCircle2 className="mr-1.5 h-4 w-4" />
                Accept{topMatch && !topMatchGone ? ` as “${topMatch.currentLabel ?? topMatch.label}”` : ""}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setMode("merge")}
                className="min-h-10 md:min-h-8 border-amber-500/50 text-amber-400 hover:bg-amber-500/10 hover:text-amber-300"
              >
                <GitMerge className="mr-1.5 h-4 w-4" />
                Merge into…
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setMode("reject")}
                className="min-h-10 md:min-h-8 border-red-500/50 text-red-400 hover:bg-red-500/10 hover:text-red-300"
              >
                <XCircle className="mr-1.5 h-4 w-4" />
                Reject
              </Button>
            </div>
          )}

          {mode === "merge" && (
            <div className="space-y-2">
              {targetGone && (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                  The chosen concept no longer exists in the knowledge graph —
                  pick a new destination below.
                </div>
              )}
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={mergeSearch}
                  onChange={(e) => {
                    setMergeSearch(e.target.value);
                    setMergeTarget(null);
                  }}
                  placeholder="Search existing concepts…"
                  className="bg-background pl-8 h-11 text-base md:h-9 md:text-sm"
                  autoFocus
                />
              </div>
              <div className="max-h-60 md:max-h-44 space-y-1 overflow-y-auto">
                {mergeMatches.length === 0 ? (
                  <div className="px-2 py-3 text-xs text-muted-foreground">
                    No concepts match that search.
                  </div>
                ) : (
                  mergeMatches.map((n) => (
                    <button
                      key={n.id}
                      onClick={() => setMergeTarget(n)}
                      className={`flex min-h-11 md:min-h-0 w-full items-center justify-between rounded-lg border px-3 py-2.5 md:py-2 text-left text-sm transition-colors ${
                        mergeTarget?.id === n.id
                          ? "border-amber-500/60 bg-amber-500/10 text-amber-300"
                          : "border-border bg-muted/20 text-foreground hover:bg-muted/50"
                      }`}
                    >
                      <span className="truncate">{n.label}</span>
                      <span className="ml-2 shrink-0 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                        {n.kind}
                      </span>
                    </button>
                  ))
                )}
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={busy || !mergeTarget}
                  onClick={() =>
                    mergeTarget &&
                    onResolve("merge", { targetNodeId: mergeTarget.id })
                  }
                  className="min-h-10 md:min-h-8 bg-amber-600 text-white hover:bg-amber-500"
                >
                  <GitMerge className="mr-1.5 h-4 w-4" />
                  Merge into {mergeTarget ? `“${mergeTarget.label}”` : "…"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setMode("idle")}
                  className="min-h-10 md:min-h-8"
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {mode === "reject" && (
            <div className="space-y-2">
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why is this being rejected? (required)"
                className="bg-background h-11 text-base md:h-9 md:text-sm"
                autoFocus
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={busy || !reason.trim()}
                  onClick={() => onResolve("reject", { reason: reason.trim() })}
                  className="min-h-10 md:min-h-8 bg-red-600 text-white hover:bg-red-500"
                >
                  <XCircle className="mr-1.5 h-4 w-4" />
                  Reject
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setMode("idle")}
                  className="min-h-10 md:min-h-8"
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
