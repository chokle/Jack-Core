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
  getListKnowledgeCandidatesQueryKey,
  getGetGraphQueryKey,
} from "@workspace/api-client-react";
import type {
  KnowledgeCandidate,
  KnowledgeNode,
  ListKnowledgeCandidatesStatus,
} from "@workspace/api-client-react";
import { AdminLogin } from "./AdminLogin";
import { MentorWithdrawal } from "./MentorWithdrawal";
import { GraphHealth } from "./GraphHealth";

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

export function KnowledgeReview() {
  // The resolve route is admin-only on the server; this check just decides
  // whether to show the login gate before the reviewer wastes effort.
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/admin/session", { credentials: "include" })
      .then((res) => res.json() as Promise<{ authenticated?: boolean }>)
      .then((body) => {
        if (alive) setIsAdmin(Boolean(body.authenticated));
      })
      .catch(() => {
        if (alive) setIsAdmin(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const [statusTab, setStatusTab] = useState<ListKnowledgeCandidatesStatus>("pending");
  const queryClient = useQueryClient();

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
      onSuccess: () => {
        setGoneCandidateId(null);
        void queryClient.invalidateQueries({ queryKey: getListKnowledgeCandidatesQueryKey({ status: statusTab }) });
        void queryClient.invalidateQueries({ queryKey: getListKnowledgeCandidatesQueryKey({ status: "pending" }) });
        void queryClient.invalidateQueries({ queryKey: getGetGraphQueryKey() });
      },
      onError: (error, variables) => {
        const body = (error as { data?: { code?: string } | null }).data;
        if (body?.code === "target_gone") {
          setGoneCandidateId(variables.id);
          // Refresh the listing so match chips show current validity.
          void queryClient.invalidateQueries({ queryKey: getListKnowledgeCandidatesQueryKey({ status: statusTab }) });
        }
      },
    },
  });

  if (isAdmin === false) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <AdminLogin onSuccess={() => setIsAdmin(true)} />
      </div>
    );
  }

  const candidates = candidatesQuery.data?.candidates ?? [];

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
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                statusTab === t.value
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

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
            {candidates.map((cand, idx) => (
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

        {isAdmin === true && <MentorWithdrawal />}
        {isAdmin === true && <GraphHealth />}
      </div>
    </div>
  );
}

function CandidateCard({
  candidate,
  conceptNodes,
  nodeLabelById,
  busy,
  targetGone,
  onResolve,
}: {
  candidate: KnowledgeCandidate;
  conceptNodes: KnowledgeNode[];
  /** Node id → human label, for rendering resolution targets by name. */
  nodeLabelById: Map<string, string>;
  busy: boolean;
  /** The last resolve attempt failed because the target vanished — open the merge picker. */
  targetGone: boolean;
  onResolve: (
    action: "accept" | "merge" | "reject" | "restore" | "rearchive",
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
            className="bg-emerald-600 text-white hover:bg-emerald-500"
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
            title="Undo this restore — move the concept back to archived knowledge"
          >
            <Archive className="mr-1.5 h-4 w-4" />
            Re-archive
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
                className="bg-emerald-600 text-white hover:bg-emerald-500"
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
                className="border-amber-500/50 text-amber-400 hover:bg-amber-500/10 hover:text-amber-300"
              >
                <GitMerge className="mr-1.5 h-4 w-4" />
                Merge into…
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setMode("reject")}
                className="border-red-500/50 text-red-400 hover:bg-red-500/10 hover:text-red-300"
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
                  className="bg-background pl-8"
                  autoFocus
                />
              </div>
              <div className="max-h-44 space-y-1 overflow-y-auto">
                {mergeMatches.length === 0 ? (
                  <div className="px-2 py-3 text-xs text-muted-foreground">
                    No concepts match that search.
                  </div>
                ) : (
                  mergeMatches.map((n) => (
                    <button
                      key={n.id}
                      onClick={() => setMergeTarget(n)}
                      className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
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
                  className="bg-amber-600 text-white hover:bg-amber-500"
                >
                  <GitMerge className="mr-1.5 h-4 w-4" />
                  Merge into {mergeTarget ? `“${mergeTarget.label}”` : "…"}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setMode("idle")}>
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
                className="bg-background"
                autoFocus
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={busy || !reason.trim()}
                  onClick={() => onResolve("reject", { reason: reason.trim() })}
                  className="bg-red-600 text-white hover:bg-red-500"
                >
                  <XCircle className="mr-1.5 h-4 w-4" />
                  Reject
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setMode("idle")}>
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
