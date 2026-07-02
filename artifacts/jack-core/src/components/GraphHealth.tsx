import { useMemo } from "react";
import {
  Activity,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Clock,
  Loader2,
  RotateCcw,
  Video,
  MessageSquare,
} from "lucide-react";
import { motion } from "framer-motion";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  useGetGraphHealth,
  useRedistillInterviewAnswer,
  getGetGraphHealthQueryKey,
} from "@workspace/api-client-react";
import type {
  GraphHealthWrite,
  GraphWriteChecks,
  WriteCheck,
} from "@workspace/api-client-react";

const CHECK_LABELS: { key: keyof GraphWriteChecks; label: string }[] = [
  { key: "nodesExist", label: "Nodes" },
  { key: "edgesExist", label: "Edges" },
  { key: "provenanceStored", label: "Provenance" },
  { key: "confidenceUpdated", label: "Confidence" },
  { key: "searchIndexUpdated", label: "Search index" },
];

function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function relTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * Admin-only Graph Health dashboard. Rendered inside the Review screen's
 * admin block (no self-gate — it assumes an authenticated admin context, like
 * MentorWithdrawal). Surfaces knowledge-write verification: how many writes
 * verified/partial/failed, what is still queued for retry, and a log of recent
 * writes with per-check detail. Failed mentor-answer writes get a one-click
 * "Retry distillation" that re-runs distillation + verification for that answer.
 */
export function GraphHealth() {
  const queryClient = useQueryClient();

  const healthQuery = useGetGraphHealth({
    query: {
      queryKey: getGetGraphHealthQueryKey(),
      // Health drifts as background jobs finish — keep it lightly fresh.
      refetchInterval: 15000,
    },
  });

  const redistill = useRedistillInterviewAnswer({
    request: { credentials: "include" },
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getGetGraphHealthQueryKey() });
      },
    },
  });

  const report = healthQuery.data;

  const summaryCards = useMemo(() => {
    const c = report?.counts;
    return [
      {
        label: "Verified",
        value: c?.verified ?? 0,
        icon: CheckCircle2,
        tone: "text-emerald-400",
        ring: "border-emerald-500/30 bg-emerald-500/5",
      },
      {
        label: "Partial",
        value: c?.partial ?? 0,
        icon: AlertTriangle,
        tone: "text-amber-400",
        ring: "border-amber-500/30 bg-amber-500/5",
      },
      {
        label: "Failed",
        value: c?.failed ?? 0,
        icon: XCircle,
        tone: "text-red-400",
        ring: "border-red-500/30 bg-red-500/5",
      },
      {
        label: "Pending",
        value: c?.pending ?? 0,
        icon: Clock,
        tone: "text-sky-400",
        ring: "border-sky-500/30 bg-sky-500/5",
      },
    ];
  }, [report]);

  return (
    <div className="mt-10 border-t border-border/70 pt-8">
      <div className="mb-1 flex items-center gap-2">
        <Activity className="h-5 w-5 text-primary" />
        <h2 className="text-lg font-bold tracking-tight">Graph Health</h2>
      </div>
      <p className="mb-6 text-sm text-muted-foreground">
        Every video and mentor answer is verified after its knowledge is written to
        the graph — nodes, edges, provenance, confidence, and the search index. Writes
        that don't fully land are flagged here and retried in the background.
      </p>

      {healthQuery.isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading health…
        </div>
      ) : healthQuery.isError ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          Could not load graph health. The knowledge-write log table may not be applied yet.
        </div>
      ) : (
        <>
          {/* Summary counts */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {summaryCards.map((card) => (
              <div
                key={card.label}
                className={`rounded-xl border p-4 backdrop-blur-sm ${card.ring}`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {card.label}
                  </span>
                  <card.icon className={`h-4 w-4 ${card.tone}`} />
                </div>
                <div className={`mt-2 text-2xl font-bold tabular-nums ${card.tone}`}>
                  {card.value}
                </div>
              </div>
            ))}
          </div>

          {/* Retry queue + throughput */}
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="flex items-center gap-3 rounded-xl border border-border bg-card/60 p-4 backdrop-blur-sm">
              <Video className="h-4 w-4 text-muted-foreground" />
              <div>
                <div className="text-xs uppercase tracking-wider text-muted-foreground">
                  Videos flagged
                </div>
                <div className="text-lg font-bold tabular-nums">
                  {report?.retryQueue.videos ?? 0}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3 rounded-xl border border-border bg-card/60 p-4 backdrop-blur-sm">
              <MessageSquare className="h-4 w-4 text-muted-foreground" />
              <div>
                <div className="text-xs uppercase tracking-wider text-muted-foreground">
                  Answers flagged
                </div>
                <div className="text-lg font-bold tabular-nums">
                  {report?.retryQueue.answers ?? 0}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3 rounded-xl border border-border bg-card/60 p-4 backdrop-blur-sm">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <div>
                <div className="text-xs uppercase tracking-wider text-muted-foreground">
                  Avg processing
                </div>
                <div className="text-lg font-bold tabular-nums">
                  {formatMs(report?.avgProcessingMs)}
                </div>
              </div>
            </div>
          </div>

          {/* Recent writes */}
          <div className="mt-6">
            <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Recent knowledge writes
            </div>
            {(report?.recentWrites.length ?? 0) === 0 ? (
              <div className="rounded-xl border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
                No knowledge writes recorded yet.
              </div>
            ) : (
              <div className="space-y-2">
                {report?.recentWrites.map((w, idx) => (
                  <motion.div
                    key={w.id}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: Math.min(idx * 0.03, 0.24) }}
                  >
                    <WriteRow
                      write={w}
                      busy={redistill.isPending}
                      onRedistill={() => redistill.mutate({ id: w.refId })}
                    />
                  </motion.div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function statusStyle(status: GraphHealthWrite["status"]): {
  icon: typeof CheckCircle2;
  tone: string;
  label: string;
} {
  switch (status) {
    case "verified":
      return { icon: CheckCircle2, tone: "text-emerald-400", label: "Verified" };
    case "partial":
      return { icon: AlertTriangle, tone: "text-amber-400", label: "Partial" };
    case "failed":
      return { icon: XCircle, tone: "text-red-400", label: "Failed" };
    default:
      return { icon: Clock, tone: "text-sky-400", label: "Pending" };
  }
}

function WriteRow({
  write,
  busy,
  onRedistill,
}: {
  write: GraphHealthWrite;
  busy: boolean;
  onRedistill: () => void;
}) {
  const s = statusStyle(write.status);
  const isMentorAnswer = write.scope === "mentor_answer";
  const canRetry = isMentorAnswer && write.status !== "verified";

  return (
    <div className="rounded-xl border border-border bg-card/60 p-3 backdrop-blur-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <s.icon className={`h-4 w-4 shrink-0 ${s.tone}`} />
            <span className={`text-sm font-semibold ${s.tone}`}>{s.label}</span>
            <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              {isMentorAnswer ? "Mentor answer" : "Video"}
            </span>
            {write.attempts > 1 && (
              <span className="font-mono text-[10px] text-muted-foreground">
                attempt {write.attempts}
              </span>
            )}
            {write.updatedAt && (
              <span className="font-mono text-[10px] text-muted-foreground">
                {relTime(write.updatedAt)}
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground/70">
            {write.refId}
          </div>
        </div>
        {canRetry && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={onRedistill}
            className="border-sky-500/50 text-sky-400 hover:bg-sky-500/10 hover:text-sky-300"
            title="Re-run distillation + verification for this answer"
          >
            <RotateCcw className="mr-1.5 h-4 w-4" />
            Retry distillation
          </Button>
        )}
      </div>

      {/* Per-check pills */}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {CHECK_LABELS.map(({ key, label }) => {
          const check: WriteCheck = write.checks[key];
          return (
            <span
              key={key}
              title={check.detail}
              className={`rounded-md border px-2 py-0.5 text-[11px] ${
                check.ok
                  ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-300/90"
                  : "border-red-500/30 bg-red-500/5 text-red-300/90"
              }`}
            >
              {check.ok ? "✓" : "✕"} {label}
            </span>
          );
        })}
      </div>

      {write.error && (
        <div className="mt-2 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-1.5 text-xs text-red-300/90">
          {write.error}
        </div>
      )}
    </div>
  );
}
