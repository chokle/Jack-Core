import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
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

interface TimelineEvent {
  eventId: string;
  eventType: string;
  occurredAt: string;
  surface: string;
  result: string;
  metadata: Record<string, string | number | boolean>;
}

type IntegrityState =
  | "VERIFIED_COMPLETE"
  | "VERIFIED_ZERO_ACTIVITY"
  | "INCOMPLETE_TELEMETRY"
  | "ATTRIBUTION_ANOMALY";

interface EndOfDayResponse {
  report: {
    reportState: IntegrityState;
    window: { start: string; end: string };
    assignedParticipantCount: number;
    authenticatedUserCount: number;
    activeUserCount: number;
    inactiveAssignedUserCount: number;
    verifiedActiveMs: number;
    feedbackSubmissionCount: number;
    failedEventCount: number;
    outsideCohortActors: string[];
    users: Array<{
      actorUserId: string;
      authenticated: boolean;
      active: boolean;
      firstActivityAt: string | null;
      lastActivityAt: string | null;
      sessionCount: number;
      verifiedActiveMs: number;
      eventCounts: Record<string, number>;
    }>;
    telemetryHealth: {
      complete: boolean;
      telemetryPathObserved: boolean;
      malformedEventCount: number;
      inactivityCutoffMs: number;
    };
    provenance: {
      sources: string[];
      eventTypes: string[];
      windowStart: string;
      windowEnd: string;
    };
  };
  generatedAt: string;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "include", ...init });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || "Report request failed.");
  return body;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function duration(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

const INTEGRITY_LABELS: Record<IntegrityState, string> = {
  VERIFIED_COMPLETE: "Verified complete",
  VERIFIED_ZERO_ACTIVITY: "Verified zero activity",
  INCOMPLETE_TELEMETRY: "Incomplete telemetry",
  ATTRIBUTION_ANOMALY: "Attribution anomaly",
};

export function PilotActivityReports() {
  const [scopes, setScopes] = useState<ReportScope[]>([]);
  const [selectedKey, setSelectedKey] = useState("");
  const [report, setReport] = useState<SummaryResponse | null>(null);
  const [timeline, setTimeline] = useState<{ userId: string; events: TimelineEvent[] } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [reportDate, setReportDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [endOfDay, setEndOfDay] = useState<EndOfDayResponse | null>(null);
  const [loadingEndOfDay, setLoadingEndOfDay] = useState(false);
  const selected = useMemo(
    () => scopes.find((scope) => `${scope.organizationId}:${scope.pilotId}` === selectedKey),
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
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Reports unavailable."));
  }, []);

  useEffect(() => {
    if (!query) return;
    setTimeline(null);
    setEndOfDay(null);
    setError(null);
    void json<SummaryResponse>(`/api/testing/reports/summary?${query}`)
      .then(setReport)
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Reports unavailable."));
  }, [query]);

  const loadEndOfDay = async () => {
    setLoadingEndOfDay(true);
    setError(null);
    setEndOfDay(null);
    try {
      setEndOfDay(await json<EndOfDayResponse>(
        `/api/testing/reports/end-of-day?${query}&date=${encodeURIComponent(reportDate)}`,
      ));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "End-of-day report unavailable.");
    } finally {
      setLoadingEndOfDay(false);
    }
  };

  const loadTimeline = async (userId: string) => {
    try {
      const body = await json<{ actorUserId: string; events: TimelineEvent[] }>(
        `/api/testing/reports/users/${encodeURIComponent(userId)}/timeline?${query}`,
      );
      setTimeline({ userId: body.actorUserId, events: body.events });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Timeline unavailable.");
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
      setError(reason instanceof Error ? reason.message : "Report generation failed.");
    } finally {
      setGenerating(false);
    }
  };

  return (
    <main className="h-full overflow-y-auto p-6 print:bg-white print:text-black">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-primary">Admin only</p>
            <h1 className="text-2xl font-bold">Pilot activity reports</h1>
            <p className="text-sm text-muted-foreground">
              Organization-isolated, minimized telemetry. Ask Jack content is never shown here.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 print:hidden">
            <Button variant="outline" onClick={() => window.print()} disabled={!report}>
              Print
            </Button>
            <Button
              variant="outline"
              disabled={!query}
              onClick={() => window.location.assign(`/api/testing/reports/export.csv?${query}`)}
            >
              Export CSV
            </Button>
            <Button disabled={!query || generating} onClick={() => void generate()}>
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
                {scope.organizationName ?? "Organization"} — {scope.pilotName ?? "Pilot"}
              </option>
            ))}
          </select>
        </label>

        <section className="rounded-lg border border-border p-4">
          <div className="flex flex-wrap items-end gap-3 print:hidden">
            <label className="text-sm">
              End-of-day report date (UTC)
              <input
                aria-label="End-of-day report date (UTC)"
                type="date"
                className="mt-1 block rounded-md border border-border bg-background p-2"
                value={reportDate}
                onChange={(event) => {
                  setReportDate(event.target.value);
                  setEndOfDay(null);
                }}
              />
            </label>
            <Button disabled={!query || !reportDate || loadingEndOfDay} onClick={() => void loadEndOfDay()}>
              {loadingEndOfDay ? "Loading…" : "Load end-of-day report"}
            </Button>
          </div>

          {endOfDay && (
            <div className="mt-4 space-y-4" data-testid="end-of-day-report">
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Integrity state</p>
                <h2 className="text-xl font-bold">{INTEGRITY_LABELS[endOfDay.report.reportState]}</h2>
                {endOfDay.report.reportState === "INCOMPLETE_TELEMETRY" && (
                  <p>Activity totals are not certified complete for this UTC window.</p>
                )}
                {endOfDay.report.reportState === "ATTRIBUTION_ANOMALY" && (
                  <p>Activity includes accounts outside the assigned pilot cohort.</p>
                )}
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  ["Assigned", endOfDay.report.assignedParticipantCount],
                  ["Authenticated", endOfDay.report.authenticatedUserCount],
                  ["Active", endOfDay.report.activeUserCount],
                  ["Inactive assigned", endOfDay.report.inactiveAssignedUserCount],
                  ["Verified active time", duration(endOfDay.report.verifiedActiveMs)],
                  ["Feedback", endOfDay.report.feedbackSubmissionCount],
                  ["Failed events", endOfDay.report.failedEventCount],
                ].map(([label, value]) => (
                  <div key={label} className="rounded border border-border p-3">
                    <p className="text-xs text-muted-foreground">{label}</p>
                    <p className="font-semibold">{value}</p>
                  </div>
                ))}
              </div>

              {endOfDay.report.outsideCohortActors.length > 0 && (
                <p>Outside-cohort accounts: {endOfDay.report.outsideCohortActors.join(", ")}</p>
              )}

              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead><tr>
                    <th className="p-2">Participant ID</th>
                    <th className="p-2">Authenticated</th>
                    <th className="p-2">Active</th>
                    <th className="p-2">Sessions</th>
                    <th className="p-2">Verified active time</th>
                    <th className="p-2">First / last activity</th>
                  </tr></thead>
                  <tbody>{endOfDay.report.users.map((user) => (
                    <tr key={user.actorUserId} className="border-t border-border">
                      <td className="p-2 font-mono text-xs">{user.actorUserId}</td>
                      <td className="p-2">{user.authenticated ? "Yes" : "No"}</td>
                      <td className="p-2">{user.active ? "Yes" : "No"}</td>
                      <td className="p-2">{user.sessionCount}</td>
                      <td className="p-2">{duration(user.verifiedActiveMs)}</td>
                      <td className="p-2">
                        {user.firstActivityAt ?? "—"} / {user.lastActivityAt ?? "—"}
                      </td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>

              <details>
                <summary className="cursor-pointer font-semibold">Telemetry traceability</summary>
                <dl className="mt-2 grid gap-2 text-sm">
                  <div><dt className="font-medium">UTC window</dt><dd>{endOfDay.report.provenance.windowStart} — {endOfDay.report.provenance.windowEnd}</dd></div>
                  <div><dt className="font-medium">Sources</dt><dd>{endOfDay.report.provenance.sources.join(", ")}</dd></div>
                  <div><dt className="font-medium">Event types</dt><dd>{endOfDay.report.provenance.eventTypes.join(", ") || "None"}</dd></div>
                  <div><dt className="font-medium">Generated</dt><dd>{endOfDay.generatedAt}</dd></div>
                </dl>
              </details>
            </div>
          )}
        </section>

        {error && <p className="rounded-lg border border-destructive p-3 text-destructive">{error}</p>}
        {scopes.length === 0 && !error && <p>No active report scope is assigned.</p>}

        {report && (
          <>
            <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {[
                ["Participants", report.summary.participantCount],
                ["Completed", report.summary.completedSessions],
                ["Completion rate", percent(report.summary.completionRate)],
                ["Onboarding complete", percent(report.summary.onboardingCompletionRate)],
                ["Recording opt-in", percent(report.summary.recordingOptInRate)],
                ["Feedback", report.summary.feedbackCount],
                ["Dropped events", report.summary.droppedEventCount],
                ["Rejected events", report.summary.rejectedEventCount],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border border-border bg-card p-4">
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
                      <td className="p-3">{new Date(user.lastActivityAt).toLocaleString()}</td>
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
                <li key={event.eventId} className="rounded bg-muted/40 p-3 text-sm">
                  <span className="font-semibold">{event.eventType}</span>
                  <span className="ml-2 text-muted-foreground">
                    {new Date(event.occurredAt).toLocaleString()} · {event.result}
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
