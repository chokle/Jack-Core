import { useEffect, useMemo, useState } from "react";
import { type ChangeEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { UserTestFeedbackReview } from "./UserTestFeedbackReview";

interface ReportScope {
  organizationId: string;
  pilotId: string;
  organizationName?: string;
  pilotName?: string;
  authority: string;
}

interface SessionRow {
  id: string;
  actorUserId: string;
  status: string;
  startedAt: string;
  lastActivityAt: string;
  onboardingStatus: string;
  questionCount: number;
  recordingStatus: string;
  feedbackStatus: string;
  errorCount: number;
}

interface SummaryResponse {
  summary: {
    participantCount: number;
    sessionCount: number;
    completedSessions: number;
    completionRate: number;
    onboardingCompletionRate: number;
    recordingOptInRate: number;
    feedbackCount: number;
    droppedEventCount: number;
    rejectedEventCount: number;
    eventCounts: Record<string, number>;
  };
  users: SessionRow[];
  generatedAt: string;
}

interface CloseoutRow {
  id: string;
  actorUserId: string;
  workDate: string;
  shift: string;
  crew: string | null;
  trade: string | null;
  status: string;
  submittedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CloseoutResponse {
  scope: { organizationId: string; pilotId: string };
  closeouts: CloseoutRow[];
  limit: number;
  count: number;
  truncated: boolean;
}

interface TimelineEvent {
  eventId: string;
  eventType: string;
  occurredAt: string;
  surface: string;
  result: string;
  metadata: Record<string, string | number | boolean>;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "include", ...init });
  const body = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!response.ok) throw new Error(body.error || "Report request failed.");
  return body;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function PilotActivityReports() {
  const [scopes, setScopes] = useState<ReportScope[]>([]);
  const [selectedKey, setSelectedKey] = useState("");
  const [report, setReport] = useState<SummaryResponse | null>(null);
  const [timeline, setTimeline] = useState<{
    userId: string;
    events: TimelineEvent[];
  } | null>(null);
  const [closeoutState, setCloseoutState] = useState<
    "all" | "draft" | "submitted"
  >("all");
  const [workDateFrom, setWorkDateFrom] = useState("");
  const [workDateTo, setWorkDateTo] = useState("");
  const [closeoutLimit, setCloseoutLimit] = useState(25);
  const [closeouts, setCloseouts] = useState<CloseoutRow[] | null>(null);
  const [closeoutCount, setCloseoutCount] = useState(0);
  const [closeoutTruncated, setCloseoutTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const selected = useMemo(
    () =>
      scopes.find(
        (scope) => `${scope.organizationId}:${scope.pilotId}` === selectedKey,
      ),
    [scopes, selectedKey],
  );
  const query = selected
    ? `organizationId=${encodeURIComponent(selected.organizationId)}&pilotId=${encodeURIComponent(selected.pilotId)}`
    : "";

  useEffect(() => {
    void json<{ scopes: ReportScope[] }>("/api/testing/reports/scopes")
      .then((body) => {
        setScopes(body.scopes);
        const first = body.scopes[0];
        if (first) setSelectedKey(`${first.organizationId}:${first.pilotId}`);
      })
      .catch((reason) =>
        setError(
          reason instanceof Error ? reason.message : "Reports unavailable.",
        ),
      );
  }, []);

  useEffect(() => {
    if (!query) return;
    setTimeline(null);
    setError(null);
    void json<SummaryResponse>(`/api/testing/reports/summary?${query}`)
      .then(setReport)
      .catch((reason) =>
        setError(
          reason instanceof Error ? reason.message : "Reports unavailable.",
        ),
      );
  }, [query]);

  useEffect(() => {
    if (selected) return;
    setCloseouts(null);
    setCloseoutCount(0);
    setCloseoutTruncated(false);
  }, [selected]);

  useEffect(() => {
    if (!selected) return;
    const closeoutParams = new URLSearchParams(query);
    closeoutParams.set("limit", String(closeoutLimit));
    if (closeoutState !== "all") closeoutParams.set("state", closeoutState);
    if (workDateFrom) closeoutParams.set("workDateFrom", workDateFrom);
    if (workDateTo) closeoutParams.set("workDateTo", workDateTo);
    void json<CloseoutResponse>(
      `/api/testing/reports/closeouts?${closeoutParams}`,
    )
      .then((body) => {
        setCloseouts(body.closeouts);
        setCloseoutCount(body.count);
        setCloseoutTruncated(body.truncated);
      })
      .catch((reason) =>
        setError(
          reason instanceof Error ? reason.message : "Closeouts unavailable.",
        ),
      );
    return () => {
      setCloseouts(null);
      setCloseoutCount(0);
      setCloseoutTruncated(false);
    };
  }, [closeoutLimit, closeoutState, query, selected, workDateFrom, workDateTo]);

  const loadTimeline = async (userId: string) => {
    try {
      const body = await json<{ actorUserId: string; events: TimelineEvent[] }>(
        `/api/testing/reports/users/${encodeURIComponent(userId)}/timeline?${query}`,
      );
      setTimeline({ userId: body.actorUserId, events: body.events });
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Timeline unavailable.",
      );
    }
  };

  const generate = async () => {
    setGenerating(true);
    try {
      await json(`/api/testing/reports/generate?${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportType: "pilot_summary" }),
      });
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Report generation failed.",
      );
    } finally {
      setGenerating(false);
    }
  };

  return (
    <main className="h-full overflow-y-auto p-6 print:bg-white print:text-black">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-primary">
              Admin only
            </p>
            <h1 className="text-2xl font-bold">Pilot activity reports</h1>
            <p className="text-sm text-muted-foreground">
              Organization-isolated, minimized telemetry. Ask Jack content is
              never shown here.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 print:hidden">
            <Button
              variant="outline"
              onClick={() => window.print()}
              disabled={!report}
            >
              Print
            </Button>
            <Button
              variant="outline"
              disabled={!query}
              onClick={() =>
                window.location.assign(
                  `/api/testing/reports/export.csv?${query}`,
                )
              }
            >
              Export CSV
            </Button>
            <Button
              disabled={!query || generating}
              onClick={() => void generate()}
            >
              {generating ? "Generating…" : "Generate report"}
            </Button>
          </div>
        </header>

        <label className="block max-w-xl text-sm print:hidden">
          Organization and pilot
          <select
            className="mt-1 w-full rounded-md border border-border bg-background p-2"
            value={selectedKey}
            onChange={(event) => setSelectedKey(event.target.value)}
          >
            {scopes.map((scope) => (
              <option
                key={`${scope.organizationId}:${scope.pilotId}`}
                value={`${scope.organizationId}:${scope.pilotId}`}
              >
                {scope.organizationName ?? "Organization"} —{" "}
                {scope.pilotName ?? "Pilot"}
              </option>
            ))}
          </select>
        </label>

        {error && (
          <p className="rounded-lg border border-destructive p-3 text-destructive">
            {error}
          </p>
        )}
        {scopes.length === 0 && !error && (
          <p>No active report scope is assigned.</p>
        )}

        {report && (
          <>
            <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {[
                ["Participants", report.summary.participantCount],
                ["Completed", report.summary.completedSessions],
                ["Completion rate", percent(report.summary.completionRate)],
                [
                  "Onboarding complete",
                  percent(report.summary.onboardingCompletionRate),
                ],
                [
                  "Recording opt-in",
                  percent(report.summary.recordingOptInRate),
                ],
                ["Feedback", report.summary.feedbackCount],
                ["Dropped events", report.summary.droppedEventCount],
                ["Rejected events", report.summary.rejectedEventCount],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="rounded-lg border border-border bg-card p-4"
                >
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className="mt-1 text-2xl font-bold">{value}</p>
                </div>
              ))}
            </section>

            <section className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="p-3">Participant ID</th>
                    <th className="p-3">Status</th>
                    <th className="p-3">Onboarding</th>
                    <th className="p-3">Ask Jack uses</th>
                    <th className="p-3">Last activity</th>
                  </tr>
                </thead>
                <tbody>
                  {report.users.map((user) => (
                    <tr key={user.id} className="border-t border-border">
                      <td className="p-3">
                        <button
                          className="font-mono text-xs text-primary underline print:text-black"
                          onClick={() => void loadTimeline(user.actorUserId)}
                        >
                          {user.actorUserId}
                        </button>
                      </td>
                      <td className="p-3">{user.status}</td>
                      <td className="p-3">{user.onboardingStatus}</td>
                      <td className="p-3">{user.questionCount}</td>
                      <td className="p-3">
                        {new Date(user.lastActivityAt).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </>
        )}

        {timeline && (
          <section className="rounded-lg border border-border p-4">
            <h2 className="font-semibold">Timeline: {timeline.userId}</h2>
            <ol className="mt-3 space-y-2">
              {timeline.events.map((event) => (
                <li
                  key={event.eventId}
                  className="rounded bg-muted/40 p-3 text-sm"
                >
                  <span className="font-semibold">{event.eventType}</span>
                  <span className="ml-2 text-muted-foreground">
                    {new Date(event.occurredAt).toLocaleString()} ·{" "}
                    {event.result}
                  </span>
                  {Object.keys(event.metadata).length > 0 && (
                    <span className="ml-2 font-mono text-xs">
                      {JSON.stringify(event.metadata)}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </section>
        )}
        <section className="space-y-3 rounded-lg border border-border p-4">
          <header className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-semibold">End-of-Shift Closeouts</h2>
            <div className="text-sm text-muted-foreground">
              {query
                ? `Showing ${closeouts?.length ?? 0} of ${closeoutCount}`
                : "Select a scope"}
            </div>
          </header>
          {query && (
            <div className="grid gap-3 md:grid-cols-4">
              <label className="text-sm">
                State
                <select
                  className="mt-1 w-full rounded-md border border-border bg-background p-2"
                  value={closeoutState}
                  onChange={(event) =>
                    setCloseoutState(
                      event.target.value as "all" | "draft" | "submitted",
                    )
                  }
                >
                  <option value="all">All</option>
                  <option value="draft">Draft</option>
                  <option value="submitted">Submitted</option>
                </select>
              </label>
              <label className="text-sm">
                Limit
                <Input
                  type="number"
                  min={1}
                  max={100}
                  value={closeoutLimit}
                  onChange={(event: ChangeEvent<HTMLInputElement>) =>
                    setCloseoutLimit(Number(event.target.value || 25))
                  }
                />
              </label>
              <label className="text-sm">
                Work date from
                <Input
                  type="date"
                  value={workDateFrom}
                  onChange={(event: ChangeEvent<HTMLInputElement>) =>
                    setWorkDateFrom(event.target.value)
                  }
                />
              </label>
              <label className="text-sm">
                Work date to
                <Input
                  type="date"
                  value={workDateTo}
                  onChange={(event: ChangeEvent<HTMLInputElement>) =>
                    setWorkDateTo(event.target.value)
                  }
                />
              </label>
            </div>
          )}
          {!query ? (
            <p>No scope selected.</p>
          ) : closeouts === null ? (
            <p className="text-sm text-muted-foreground">Loading closeouts…</p>
          ) : closeouts.length === 0 ? (
            <p>No closeout submissions.</p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="p-3">Participant</th>
                      <th className="p-3">Date</th>
                      <th className="p-3">Shift</th>
                      <th className="p-3">Trade</th>
                      <th className="p-3">Crew</th>
                      <th className="p-3">Status</th>
                      <th className="p-3">Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {closeouts.map((entry) => (
                      <tr key={entry.id} className="border-t border-border">
                        <td className="p-3 font-mono text-xs">
                          {entry.actorUserId}
                        </td>
                        <td className="p-3">{entry.workDate}</td>
                        <td className="p-3">{entry.shift}</td>
                        <td className="p-3">{entry.trade ?? "—"}</td>
                        <td className="p-3">{entry.crew ?? "—"}</td>
                        <td className="p-3 capitalize">{entry.status}</td>
                        <td className="p-3">
                          {new Date(entry.updatedAt).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {closeoutTruncated && (
                <p className="text-xs text-muted-foreground">
                  Results were truncated to the selected limit.
                </p>
              )}
            </>
          )}
        </section>

        {selected && (
          <UserTestFeedbackReview
            organizationId={selected.organizationId}
            pilotId={selected.pilotId}
          />
        )}
      </div>
    </main>
  );
}
