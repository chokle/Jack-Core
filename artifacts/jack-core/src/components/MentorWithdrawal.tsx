import { useState } from "react";
import { Loader2, ShieldAlert, User, UserX } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
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
import {
  useListMentors,
  usePreviewMentorWithdrawal,
  useWithdrawMentor,
  getListMentorsQueryKey,
  getListKnowledgeCandidatesQueryKey,
  getGetGraphQueryKey,
  getGetMentorContributionsQueryKey,
  getPreviewMentorWithdrawalQueryKey,
} from "@workspace/api-client-react";
import type { MentorSummary, MentorWithdrawalResult } from "@workspace/api-client-react";

/** Cap the concept names shown inline before collapsing to a "+N more" note. */
const MAX_ARCHIVED_NAMES = 8;

/**
 * Dry-run impact preview shown inside the confirm dialog. Fetches the read-only
 * withdrawal projection so the admin sees the concrete counts — and the names of
 * concepts that would leave the graph — BEFORE confirming this irreversible act.
 */
function WithdrawalImpactPreview({ mentorId }: { mentorId: string }) {
  const previewQuery = usePreviewMentorWithdrawal(mentorId, {
    request: { credentials: "include" },
    query: { queryKey: getPreviewMentorWithdrawalQueryKey(mentorId), staleTime: 0 },
  });

  if (previewQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 p-3 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Calculating impact…
      </div>
    );
  }

  if (previewQuery.isError || !previewQuery.data) {
    return (
      <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-amber-200/90">
        Couldn't load the impact preview. You can still withdraw, but the exact effect isn't shown.
      </div>
    );
  }

  const p = previewQuery.data;
  const archivedNames = p.archivedConcepts ?? [];
  const shownNames = archivedNames.slice(0, MAX_ARCHIVED_NAMES);
  const extraNames = archivedNames.length - shownNames.length;

  return (
    <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
      <div className="font-medium text-foreground">What this withdrawal will do:</div>
      <ul className="grid gap-1 sm:grid-cols-2">
        <li>
          <span className="font-mono font-semibold text-foreground">{p.conceptsRetained}</span>{" "}
          concept{p.conceptsRetained === 1 ? "" : "s"} retained on other evidence
        </li>
        <li>
          <span className="font-mono font-semibold text-destructive">{p.conceptsArchived}</span>{" "}
          mentor-only concept{p.conceptsArchived === 1 ? "" : "s"} archived out of the graph
        </li>
        <li>
          <span className="font-mono font-semibold text-foreground">{p.candidatesDeleted}</span>{" "}
          pending candidate{p.candidatesDeleted === 1 ? "" : "s"} deleted
        </li>
        <li>
          <span className="font-mono font-semibold text-foreground">{p.candidatesScrubbed}</span>{" "}
          resolved candidate{p.candidatesScrubbed === 1 ? "" : "s"} kept, attribution scrubbed
        </li>
      </ul>
      {archivedNames.length > 0 && (
        <div className="pt-1">
          <div className="mb-1 text-xs font-medium text-foreground">
            Concepts leaving the live graph:
          </div>
          <div className="flex flex-wrap gap-1.5">
            {shownNames.map((c) => (
              <span
                key={c.id}
                className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-xs text-destructive"
              >
                {c.label}
              </span>
            ))}
            {extraNames > 0 && (
              <span className="rounded-md border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground">
                +{extraNames} more
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Admin-only mentor roster with a confirm-guarded Withdraw action. Rendered
 * inside the already-admin-gated Review screen; the list endpoint itself is
 * also admin-gated server-side (mentor names/regions are personal data).
 */
export function MentorWithdrawal() {
  const queryClient = useQueryClient();
  const mentorsQuery = useListMentors({
    request: { credentials: "include" },
    query: { queryKey: getListMentorsQueryKey() },
  });

  const [confirming, setConfirming] = useState<MentorSummary | null>(null);
  const [lastSummary, setLastSummary] = useState<{
    mentorName: string;
    result: MentorWithdrawalResult;
  } | null>(null);

  const withdraw = useWithdrawMentor({
    request: { credentials: "include" },
    mutation: {
      onSuccess: (result) => {
        setLastSummary({ mentorName: confirming?.name ?? "Mentor", result });
        setConfirming(null);
        void queryClient.invalidateQueries({ queryKey: getListMentorsQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getGetGraphQueryKey() });
        void queryClient.invalidateQueries({
          queryKey: getGetMentorContributionsQueryKey(),
        });
        void queryClient.invalidateQueries({
          queryKey: getListKnowledgeCandidatesQueryKey({ status: "pending" }),
        });
      },
    },
  });

  const mentors = mentorsQuery.data?.mentors ?? [];

  return (
    <section className="mt-10">
      <div className="mb-1 flex items-center gap-2">
        <UserX className="h-5 w-5 text-destructive" />
        <h2 className="text-lg font-bold tracking-tight">Mentor Withdrawal</h2>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">
        Honor a mentor's request to be removed. Their personal data is erased, while
        knowledge corroborated by other sources stays in the Living Memory.
      </p>

      {lastSummary && (
        <div className="mb-4 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-4 text-sm">
          <div className="mb-2 font-semibold text-emerald-300">
            {lastSummary.mentorName} has been withdrawn
          </div>
          <ul className="grid gap-1 text-emerald-200/90 sm:grid-cols-2">
            <li>
              <span className="font-mono font-semibold">{lastSummary.result.conceptsRetained}</span>{" "}
              concept{lastSummary.result.conceptsRetained === 1 ? "" : "s"} retained on other evidence
            </li>
            <li>
              <span className="font-mono font-semibold">{lastSummary.result.conceptsArchived}</span>{" "}
              mentor-only concept{lastSummary.result.conceptsArchived === 1 ? "" : "s"} archived out of the graph
            </li>
            <li>
              <span className="font-mono font-semibold">{lastSummary.result.candidatesDeleted}</span>{" "}
              pending candidate{lastSummary.result.candidatesDeleted === 1 ? "" : "s"} deleted
            </li>
            <li>
              <span className="font-mono font-semibold">{lastSummary.result.candidatesScrubbed}</span>{" "}
              resolved candidate{lastSummary.result.candidatesScrubbed === 1 ? "" : "s"} kept, attribution scrubbed
            </li>
          </ul>
        </div>
      )}

      {withdraw.isError && (
        <div className="mb-4 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          Withdrawal failed — the mentor may already be withdrawn. Refresh and try again.
        </div>
      )}

      {mentorsQuery.isLoading ? (
        <div className="flex items-center justify-center py-10 text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading mentors…
        </div>
      ) : mentorsQuery.isError ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          Could not load mentors. Make sure you are signed in as an admin.
        </div>
      ) : mentors.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border py-10 text-muted-foreground">
          <User className="h-7 w-7" />
          <div className="text-sm">No mentors yet — interviews will add them here.</div>
        </div>
      ) : (
        <div className="space-y-3">
          {mentors.map((m) => (
            <div
              key={m.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card/60 p-4 backdrop-blur-sm"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{m.name}</span>
                  {(m.tradeInput || m.trade) && (
                    <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                      {m.tradeInput || m.trade}
                    </span>
                  )}
                  {m.region && (
                    <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                      {m.region}
                    </span>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  {typeof m.yearsExperience === "number" && (
                    <span>{m.yearsExperience} yrs experience</span>
                  )}
                  <span>
                    {m.sessionCount} session{m.sessionCount === 1 ? "" : "s"}
                  </span>
                  <span>
                    {m.answerCount} answer{m.answerCount === 1 ? "" : "s"}
                  </span>
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={withdraw.isPending}
                onClick={() => setConfirming(m)}
                className="border-red-500/50 text-red-400 hover:bg-red-500/10 hover:text-red-300"
              >
                <UserX className="mr-1.5 h-4 w-4" />
                Withdraw
              </Button>
            </div>
          ))}
        </div>
      )}

      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open && !withdraw.isPending) setConfirming(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-destructive" />
              Withdraw {confirming?.name}?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm">
                <p>This permanently removes the person, not the community's knowledge:</p>
                <ul className="list-disc space-y-1 pl-5">
                  <li>
                    <span className="font-medium text-foreground">Erased:</span> their profile,
                    interview sessions, verbatim answers, and any pending review candidates they
                    submitted.
                  </li>
                  <li>
                    <span className="font-medium text-foreground">Kept:</span> concepts corroborated
                    by videos or other mentors stay in the Living Memory with recalculated trust;
                    already-reviewed decisions keep their audit record without the mentor's name.
                  </li>
                  <li>
                    <span className="font-medium text-foreground">Archived:</span> concepts only
                    this mentor taught leave the live graph and are stored attribution-free for
                    later review.
                  </li>
                </ul>
                {confirming && <WithdrawalImpactPreview mentorId={confirming.id} />}
                <p className="font-medium text-destructive">This cannot be undone.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={withdraw.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={withdraw.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (confirming) withdraw.mutate({ id: confirming.id });
              }}
              className="bg-red-600 text-white hover:bg-red-500"
            >
              {withdraw.isPending ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <UserX className="mr-1.5 h-4 w-4" />
              )}
              Withdraw mentor
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
