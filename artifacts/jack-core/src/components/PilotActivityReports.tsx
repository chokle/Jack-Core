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

type PilotReportState =
  | "VERIFIED_COMPLETE"
  | "VERIFIED_ZERO_ACTIVITY"
  | "INCOMPLETE_TELEMETRY"
  | "ATTRIBUTION_ANOMALY";

interface EndOfDayUser {
  actorUserId: string;
  authenticated: boolean;
  active: boolean;
  firstActivityAt: string | null;
  lastActivityAt: string | null;
  sessionCount: number;
  verifiedActiveMs: number;
  eventCounts: Record<string, number>;
}

interface EndOfDayResponse {
  report: {
    reportState: PilotReportState;
    window: { start: string; end: string };
    assignedParticipantCount: number;
    authenticatedUserCount: number;
    activeUserCount: number;
    inactiveAssignedUserCount: number;
    verifiedActiveMs: number;
    feedbackSubmissionCount: number;
    failedEventCount: number;
    outsideCohortActors: string[];
    users: EndOfDayUser[];
    eventCounts: Record<string, number>;
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
  const body = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!response.ok) throw new Error(body.error || "Report request failed.");
  return body;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function duration(value: number): string {
  const minutes = Math.round(value / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

function stateLabel(value: PilotReportState): string {
  return value.replaceAll("_", " ");
}

export function PilotActivityReports() {
  const [scopes, setScopes] = useState<ReportScope[]>([]);
  const [selectedKey, setSelectedKey] = useState("");
  const [report, setReport] = useState<SummaryResponse | null>(null);
  const [timeline, setTimeline] = useState<{
    userId: string;
    events: TimelineEvent[];
  } | null>(null);
  const [reportDate, setReportDate] = useState(utcToday);
  const [endOfDay, setEndOfDay] = useState<EndOfDayResponse | null>(null);
  const [endOfDayLoading, setEndOfDayLoading] = useState(false);
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

  const loadEndOfDay = async () => {
    if (!query || !reportDate) return;
    setEndOfDayLoading(true);
    setError(null);
    try {
      const body = await json<EndOfDayResponse>(
        `/api/testing/reports/end-of-day?${query}&date=${encodeURIComponent(reportDate)}`,
      );
      setEndOfDay(body);
    } catch (reason) {
      setEndOfDay(null);
      setError(
        reason instanceof Error
          ? reason.message
          : "End-of-day report unavailable.",
      );
    } finally {
      setEndOfDayLoading(false);
    }
  };

  useEffect(() => {
    if (!query || !reportDate) return;
    void loadEndOfDay();
    // loadEndOfDay intentionally follows the selected report scope/date.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, reportDate]);

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

  const endOfDayMetrics: Array<[string, string | number]> = endOfDay
    ? [
        ["State", stateLabel(endOfDay.report.reportState)],
        ["Assigned", endOfDay.report.assignedParticipantCount],
        ["Authenticated", endOfDay.report.authenticatedUserCount],
        ["Active", endOfDay.report.activeUserCount],
        ["Verified active time", duration(endOfDay.report.verifiedActiveMs)],
        ["Feedback", endOfDay.report.feedbackSubmissionCount],
        ["Failed events", endOfDay.report.failedEventCount],
        [
          "Telemetry complete",
          endOfDay.report.telemetryHealth.complete ? "Yes" : "No",
        ],
      ]
    : [];

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

        <section className="space-y-4 rounded-lg border border-border p-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="font-semibold">
                Deterministic end-of-day evidence
              </h2>
              <p className="text-sm text-muted-foreground">
                UTC-day activity with explicit telemetry completeness and
                attribution state.
              </p>
            </div>
            <div className="flex flex-wrap items-end gap-2 print:hidden">
              <label className="text-xs text-muted-foreground">
                UTC date
                <input
                  type="date"
                  max={utcToday()}
                  value={reportDate}
                  onChange={(event) => setReportDate(event.target.value)}
                  className="mt-1 block rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
                />
              </label>
              <Button
                variant="outline"
                disabled={!query || endOfDayLoading}
                onClick={() => void loadEndOfDay()}
              >
                {endOfDayLoading ? "Refreshing…" : "Refresh EOD"}
              </Button>
            </div>
          </div>

          {endOfDay && (
            <>
              <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {endOfDayMetrics.map(([label, value]) => (
                  <div
                    key={label}
                    className="rounded-lg border border-border bg-card p-4"
                  >
                    <p className="text-xs text-muted-foreground">{label}</p>
                    <p className="mt-1 text-xl font-bold">{value}</p>
                  </div>
                ))}
              </section>

              {!endOfDay.report.telemetryHealth.complete && (
                <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                  This day is not safe to present as verified usage yet.
                  Telemetry coverage is incomplete or malformed.
                </p>
              )}
              {endOfDay.report.outsideCohortActors.length > 0 && (
                <p className="rounded-md border border-destructive p-3 text-sm text-destructive">
                  Attribution anomaly:{" "}
                  {endOfDay.report.outsideCohortActors.length} actor(s) are
                  outside the assigned pilot cohort.
                </p>
              )}

              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-left text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="p-3">Participant ID</th>
                      <th className="p-3">Authenticated</th>
                      <th className="p-3">Active</th>
                      <th className="p-3">Verified time</th>
                      <th className="p-3">First activity</th>
                      <th className="p-3">Last activity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {endOfDay.report.users.map((user) => (
                      <tr
                        key={user.actorUserId}
                        className="border-t border-border"
                      >
                        <td className="p-3 font-mono text-xs">
                          {user.actorUserId}
                        </td>
                        <td className="p-3">
                          {user.authenticated ? "Yes" : "No"}
                        </td>
                        <td className="p-3">{user.active ? "Yes" : "No"}</td>
                        <td className="p-3">
                          {duration(user.verifiedActiveMs)}
                        </td>
                        <td className="p-3">
                          {user.firstActivityAt
                            ? new Date(user.firstActivityAt).toLocaleString()
                            : "—"}
                        </td>
                        <td className="p-3">
                          {user.lastActivityAt
                            ? new Date(user.lastActivityAt).toLocaleString()
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <p className="text-xs text-muted-foreground">
                Window:{" "}
                {new Date(endOfDay.report.window.start).toLocaleString()} →{" "}
                {new Date(endOfDay.report.window.end).toLocaleString()} ·
                Generated {new Date(endOfDay.generatedAt).toLocaleString()}
              </p>
            </>
          )}
        </section>

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
