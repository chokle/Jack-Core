import { useMemo, useState } from "react";
import {
  Loader2,
  Users,
  User,
  ChevronDown,
  ChevronRight,
  Sparkles,
  CheckCircle2,
  XCircle,
  Clock,
  MessagesSquare,
  CalendarDays,
} from "lucide-react";
import {
  useListMentors,
  useGetMentorContributions,
  getListMentorsQueryKey,
  getGetMentorContributionsQueryKey,
} from "@workspace/api-client-react";
import type { MentorSummary, MentorContribution } from "@workspace/api-client-react";

/** A mentor with no graph/review footprint yet — every count reads as zero. */
const EMPTY_CONTRIBUTION: Omit<MentorContribution, "mentorProfileId"> = {
  conceptsCreated: 0,
  conceptsReinforced: 0,
  accepted: 0,
  rejected: 0,
  pending: 0,
};

/** Month + year the mentor first appeared, e.g. "Mar 2026". */
function formatMemberSince(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

/**
 * The full, merged history for one mentor: their interview activity (sessions /
 * verbatim answers, from listMentors) alongside their Living Memory footprint
 * (concepts created / reinforced and how their review candidates resolved, from
 * getMentorContributions). Read-only — nothing here mutates the graph.
 */
function MentorDetail({
  mentor,
  contribution,
}: {
  mentor: MentorSummary;
  contribution: MentorContribution | null;
}) {
  const c = contribution ?? { mentorProfileId: mentor.id, ...EMPTY_CONTRIBUTION };
  const conceptTotal = c.conceptsCreated + c.conceptsReinforced;
  const memberSince = formatMemberSince(mentor.createdAt);
  const specialties = mentor.specialties ?? [];

  return (
    <div className="mt-3 space-y-4 border-t border-border/70 pt-4">
      {/* Profile */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {typeof mentor.yearsExperience === "number" && (
          <span>{mentor.yearsExperience} yrs experience</span>
        )}
        {memberSince && (
          <span className="flex items-center gap-1">
            <CalendarDays className="h-3 w-3" /> Since {memberSince}
          </span>
        )}
      </div>
      {specialties.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {specialties.map((s) => (
            <span
              key={s}
              className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground"
            >
              {s}
            </span>
          ))}
        </div>
      )}

      {/* Interview activity */}
      <div>
        <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          Interview activity
        </div>
        <div className="grid grid-cols-2 gap-2">
          <StatTile
            icon={<MessagesSquare className="h-3.5 w-3.5" />}
            value={mentor.sessionCount}
            label={`session${mentor.sessionCount === 1 ? "" : "s"}`}
          />
          <StatTile
            icon={<User className="h-3.5 w-3.5" />}
            value={mentor.answerCount}
            label={`answer${mentor.answerCount === 1 ? "" : "s"}`}
          />
        </div>
      </div>

      {/* Living Memory footprint */}
      <div>
        <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          Living Memory footprint
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <StatTile
            icon={<Sparkles className="h-3.5 w-3.5 text-primary" />}
            value={conceptTotal}
            label={`concept${conceptTotal === 1 ? "" : "s"} sourced`}
            hint={
              conceptTotal > 0
                ? `${c.conceptsCreated} created · ${c.conceptsReinforced} reinforced`
                : undefined
            }
          />
          <StatTile
            icon={<CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />}
            value={c.accepted}
            label="accepted"
            valueClass="text-emerald-400"
          />
          <StatTile
            icon={<XCircle className="h-3.5 w-3.5 text-red-400" />}
            value={c.rejected}
            label="rejected"
            valueClass="text-red-400"
          />
          {c.pending > 0 && (
            <StatTile
              icon={<Clock className="h-3.5 w-3.5 text-amber-400" />}
              value={c.pending}
              label="pending"
              valueClass="text-amber-400"
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** One labelled figure in a mentor's detail grid. */
function StatTile({
  icon,
  value,
  label,
  hint,
  valueClass,
}: {
  icon: React.ReactNode;
  value: number;
  label: string;
  hint?: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-muted/20 p-2.5">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        {icon}
        <span className="text-[11px]">{label}</span>
      </div>
      <div className={`mt-0.5 font-mono text-lg font-semibold ${valueClass ?? "text-foreground"}`}>
        {value}
      </div>
      {hint && <div className="text-[10px] text-muted-foreground/70">{hint}</div>}
    </div>
  );
}

/**
 * Admin-only roster that gives a reviewer a single, per-mentor view of a
 * mentor's full contribution history. It joins the two aggregations that
 * otherwise live apart — listMentors (session/answer counts + profile) and
 * getMentorContributions (graph footprint + review record) — on the mentor's
 * profile id, and expands each row to a detail panel on demand. Rendered inside
 * the already-admin-gated Review screen; both endpoints are also admin-gated
 * server-side because mentor names/regions are personal data.
 */
export function MentorContributions() {
  const mentorsQuery = useListMentors({
    request: { credentials: "include" },
    query: { queryKey: getListMentorsQueryKey() },
  });
  const contributionsQuery = useGetMentorContributions({
    request: { credentials: "include" },
    query: { queryKey: getGetMentorContributionsQueryKey() },
  });

  // mentorProfileId → contribution, so each mentor row merges its footprint
  // without an extra per-mentor request.
  const contributionByMentor = useMemo(() => {
    const map = new Map<string, MentorContribution>();
    for (const c of contributionsQuery.data?.contributions ?? []) {
      map.set(c.mentorProfileId, c);
    }
    return map;
  }, [contributionsQuery.data]);

  const [openId, setOpenId] = useState<string | null>(null);

  const mentors = mentorsQuery.data?.mentors ?? [];
  const isLoading = mentorsQuery.isLoading || contributionsQuery.isLoading;
  const isError = mentorsQuery.isError || contributionsQuery.isError;

  return (
    <section className="mt-10">
      <div className="mb-1 flex items-center gap-2">
        <Users className="h-5 w-5 text-primary" />
        <h2 className="text-lg font-bold tracking-tight">Mentor Contributions</h2>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">
        A per-mentor view of who is teaching Jack. Open a mentor to see their full
        history at a glance — interview sessions and answers alongside the concepts
        they've sourced and how their review candidates have been resolved.
      </p>

      {isLoading ? (
        <div className="flex items-center justify-center py-10 text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading mentors…
        </div>
      ) : isError ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          Could not load mentor contributions. Make sure you are signed in as an admin.
        </div>
      ) : mentors.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border py-10 text-muted-foreground">
          <User className="h-7 w-7" />
          <div className="text-sm">No mentors yet — interviews will add them here.</div>
        </div>
      ) : (
        <div className="space-y-3">
          {mentors.map((m) => {
            const contribution = contributionByMentor.get(m.id) ?? null;
            const conceptTotal = contribution
              ? contribution.conceptsCreated + contribution.conceptsReinforced
              : 0;
            const isOpen = openId === m.id;
            return (
              <div
                key={m.id}
                className="rounded-xl border border-border bg-card/60 p-4 backdrop-blur-sm"
              >
                <button
                  type="button"
                  onClick={() => setOpenId(isOpen ? null : m.id)}
                  aria-expanded={isOpen}
                  className="flex w-full flex-wrap items-center justify-between gap-3 text-left"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      {isOpen ? (
                        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
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
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 pl-6 text-xs text-muted-foreground">
                      <span>
                        {m.sessionCount} session{m.sessionCount === 1 ? "" : "s"}
                      </span>
                      <span className="text-primary/90">
                        {conceptTotal} concept{conceptTotal === 1 ? "" : "s"}
                      </span>
                      <span className="text-emerald-400/90">
                        {contribution?.accepted ?? 0} accepted
                      </span>
                      <span className="text-red-400/90">
                        {contribution?.rejected ?? 0} rejected
                      </span>
                    </div>
                  </div>
                </button>

                {isOpen && <MentorDetail mentor={m} contribution={contribution} />}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
