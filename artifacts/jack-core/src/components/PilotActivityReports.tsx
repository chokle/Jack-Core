import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { PilotConversationReview } from "./PilotConversationReview";
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

interface ParticipantRow {
  actorUserId: string;
  sessionCount: number;
  askJackUseCount: number;
  latestStatus: string;
  latestOnboardingStatus: string;
  lastActivityAt: string | null;
  sessions: SessionRow[];
}

interface Reconciliation {
  enrolledTesterIds: string[];
  observedSessionActorIds: string[];
  sessionCountsByActor: Record<string, number>;
  chatActivityCountsByActor: Record<string, number>;
  likelyMismatches: {
    observedNotEnrolled: string[];
    enrolledWithoutActivity: string[];
  };
}

interface SummaryResponse {
  summary: {
    aggregateUnit: "sessions";
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
  participants: ParticipantRow[];
  sessions: SessionRow[];
  reconciliation: Reconciliation;
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
                ["Unique participants", report.summary.participantCount],
                ["Sessions", report.summary.sessionCount],
                ["Completed sessions", report.summary.completedSessions],
                [
                  "Session completion rate",
                  percent(report.summary.completionRate),
                ],
                [
                  "Sessions onboarding complete",
                  percent(report.summary.onboardingCompletionRate),
                ],
                [
                  "Sessions recording opt-in",
                  percent(report.summary.recordingOptInRate),
                ],
                ["Feedback submissions", report.summary.feedbackCount],
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

            <section className="space-y-2">
              <div>
                <h2 className="font-semibold">Participants</h2>
                <p className="text-xs text-muted-foreground">
                  One row per actor, with activity combined across their
                  sessions.
                </p>
              </div>
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-left text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="p-3">Participant ID</th>
                      <th className="p-3">Sessions</th>
                      <th className="p-3">Latest status</th>
                      <th className="p-3">Latest onboarding</th>
                      <th className="p-3">Ask Jack uses</th>
                      <th className="p-3">Last activity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.participants.map((participant) => (
                      <tr
                        key={participant.actorUserId}
                        className="border-t border-border"
                      >
                        <td className="p-3">
                          <button
                            className="font-mono text-xs text-primary underline print:text-black"
                            onClick={() =>
                              void loadTimeline(participant.actorUserId)
                            }
                          >
                            {participant.actorUserId}
                          </button>
                        </td>
                        <td className="p-3">{participant.sessionCount}</td>
                        <td className="p-3">{participant.latestStatus}</td>
                        <td className="p-3">
                          {participant.latestOnboardingStatus}
                        </td>
                        <td className="p-3">{participant.askJackUseCount}</td>
                        <td className="p-3">
                          {participant.lastActivityAt
                            ? new Date(
                                participant.lastActivityAt,
                              ).toLocaleString()
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="space-y-2">
              <div>
                <h2 className="font-semibold">Session-level records</h2>
                <p className="text-xs text-muted-foreground">
                  Each row is one test session. Completion, onboarding, and
                  recording rates above are session-based.
                </p>
              </div>
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-left text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="p-3">Session ID</th>
                      <th className="p-3">Participant ID</th>
                      <th className="p-3">Status</th>
                      <th className="p-3">Onboarding</th>
                      <th className="p-3">Ask Jack uses</th>
                      <th className="p-3">Started</th>
                      <th className="p-3">Last activity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.sessions.map((session) => (
                      <tr key={session.id} className="border-t border-border">
                        <td className="p-3 font-mono text-xs">{session.id}</td>
                        <td className="p-3 font-mono text-xs">
                          {session.actorUserId}
                        </td>
                        <td className="p-3">{session.status}</td>
                        <td className="p-3">{session.onboardingStatus}</td>
                        <td className="p-3">{session.questionCount}</td>
                        <td className="p-3">
                          {new Date(session.startedAt).toLocaleString()}
                        </td>
                        <td className="p-3">
                          {new Date(session.lastActivityAt).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="space-y-2 rounded-lg border border-border p-4">
              <div>
                <h2 className="font-semibold">
                  Identity reconciliation (read only)
                </h2>
                <p className="text-xs text-muted-foreground">
                  Counts only for enrolled testers or actors observed in this
                  pilot. Chat content is never loaded or shown.
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="p-3">Actor ID</th>
                      <th className="p-3">Enrolled</th>
                      <th className="p-3">Observed</th>
                      <th className="p-3">Sessions</th>
                      <th className="p-3">Chat messages</th>
                      <th className="p-3">Likely mismatch</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      ...new Set([
                        ...report.reconciliation.enrolledTesterIds,
                        ...report.reconciliation.observedSessionActorIds,
                      ]),
                    ]
                      .sort()
                      .map((actorUserId) => {
                        const enrolled =
                          report.reconciliation.enrolledTesterIds.includes(
                            actorUserId,
                          );
                        const observed =
                          report.reconciliation.observedSessionActorIds.includes(
                            actorUserId,
                          );
                        const mismatch =
                          report.reconciliation.likelyMismatches.observedNotEnrolled.includes(
                            actorUserId,
                          )
                            ? "Observed, not enrolled"
                            : report.reconciliation.likelyMismatches.enrolledWithoutActivity.includes(
                                  actorUserId,
                                )
                              ? "Enrolled, no activity"
                              : "—";
                        return (
                          <tr
                            key={actorUserId}
                            className="border-t border-border"
                          >
                            <td className="p-3 font-mono text-xs">
                              {actorUserId}
                            </td>
                            <td className="p-3">{enrolled ? "Yes" : "No"}</td>
                            <td className="p-3">{observed ? "Yes" : "No"}</td>
                            <td className="p-3">
                              {report.reconciliation.sessionCountsByActor[
                                actorUserId
                              ] ?? 0}
                            </td>
                            <td className="p-3">
                              {report.reconciliation.chatActivityCountsByActor[
                                actorUserId
                              ] ?? 0}
                            </td>
                            <td className="p-3">{mismatch}</td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
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
        {selected && (
          <>
            <PilotConversationReview
              organizationId={selected.organizationId}
              pilotId={selected.pilotId}
            />
            <UserTestFeedbackReview
              organizationId={selected.organizationId}
              pilotId={selected.pilotId}
            />
          </>
        )}
      </div>
    </main>
  );
}
