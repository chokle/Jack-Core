export const ACTIVE_TIME_INACTIVITY_CUTOFF_MS = 5 * 60 * 1000;

export type PilotReportState =
  | "VERIFIED_COMPLETE"
  | "VERIFIED_ZERO_ACTIVITY"
  | "INCOMPLETE_TELEMETRY"
  | "ATTRIBUTION_ANOMALY";

export interface PilotReportInput {
  windowStart: string;
  windowEnd: string;
  memberships: Array<Record<string, unknown>>;
  sessions: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  feedback: Array<Record<string, unknown>>;
  failures: Array<Record<string, unknown>>;
}

interface ActiveInterval {
  actorUserId: string;
  start: number;
  end: number;
}

function timestamp(value: unknown): number | null {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function meaningfulEvent(row: Record<string, unknown>): boolean {
  if (row["event_type"] !== "activity_heartbeat") return true;
  const metadata = row["metadata"] as Record<string, unknown> | null;
  return (
    metadata?.["visibility"] === "foreground" &&
    metadata["meaningful_activity"] === true
  );
}

function activeIntervals(
  events: Array<Record<string, unknown>>,
  windowStart: number,
  windowEnd: number,
): ActiveInterval[] {
  const byActorAndAppSession = new Map<string, number[]>();
  for (const event of events) {
    if (!meaningfulEvent(event)) continue;
    const occurredAt = timestamp(event["occurred_at"]);
    if (
      occurredAt == null ||
      occurredAt < windowStart ||
      occurredAt >= windowEnd
    )
      continue;
    const actorUserId = String(event["actor_user_id"] ?? "");
    const appSessionId = String(event["app_session_id"] ?? "");
    if (!actorUserId || !appSessionId) continue;
    const key = `${actorUserId}\u0000${appSessionId}`;
    const values = byActorAndAppSession.get(key) ?? [];
    values.push(occurredAt);
    byActorAndAppSession.set(key, values);
  }

  const intervals: ActiveInterval[] = [];
  for (const [key, values] of byActorAndAppSession) {
    const actorUserId = key.split("\u0000", 1)[0] ?? "";
    const unique = [...new Set(values)].sort((left, right) => left - right);
    for (let index = 1; index < unique.length; index += 1) {
      const previous = unique[index - 1]!;
      const current = unique[index]!;
      if (
        current > previous &&
        current - previous <= ACTIVE_TIME_INACTIVITY_CUTOFF_MS
      ) {
        intervals.push({ actorUserId, start: previous, end: current });
      }
    }
  }
  return intervals;
}

function mergedDuration(intervals: ActiveInterval[]): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((left, right) => left.start - right.start);
  let total = 0;
  let start = sorted[0]!.start;
  let end = sorted[0]!.end;
  for (const interval of sorted.slice(1)) {
    if (interval.start <= end) {
      end = Math.max(end, interval.end);
    } else {
      total += end - start;
      start = interval.start;
      end = interval.end;
    }
  }
  return total + end - start;
}

function eventCounts(
  events: Array<Record<string, unknown>>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    const eventType = String(event["event_type"] ?? "unknown");
    counts[eventType] = (counts[eventType] ?? 0) + 1;
  }
  return counts;
}

export function buildPilotEndOfDayReport(input: PilotReportInput) {
  const windowStart = timestamp(input.windowStart);
  const windowEnd = timestamp(input.windowEnd);
  if (windowStart == null || windowEnd == null || windowEnd <= windowStart) {
    throw new Error("Invalid pilot report window");
  }

  const assigned = new Set(
    input.memberships
      .filter((row) => row["role"] === "tester" && row["active"] !== false)
      .map((row) => String(row["user_id"] ?? ""))
      .filter(Boolean),
  );
  const windowEvents = input.events.filter((event) => {
    const occurredAt = timestamp(event["occurred_at"]);
    return (
      occurredAt != null && occurredAt >= windowStart && occurredAt < windowEnd
    );
  });
  const attributedActors = new Set(
    windowEvents.map((row) => String(row["actor_user_id"] ?? "")),
  );
  const outsideCohort = [...attributedActors]
    .filter((actor) => actor && !assigned.has(actor))
    .sort();
  const intervals = activeIntervals(windowEvents, windowStart, windowEnd);

  const users = [...assigned].sort().map((actorUserId) => {
    const actorEvents = windowEvents.filter(
      (row) => row["actor_user_id"] === actorUserId,
    );
    const actorSessions = input.sessions.filter(
      (row) => row["actor_user_id"] === actorUserId,
    );
    const activityTimestamps = actorEvents
      .map((row) => timestamp(row["occurred_at"]))
      .filter((value): value is number => value != null)
      .sort((left, right) => left - right);
    return {
      actorUserId,
      authenticated: actorSessions.length > 0,
      active: actorEvents.length > 0,
      firstActivityAt: activityTimestamps.length
        ? new Date(activityTimestamps[0]!).toISOString()
        : null,
      lastActivityAt: activityTimestamps.length
        ? new Date(activityTimestamps.at(-1)!).toISOString()
        : null,
      sessionCount: new Set(actorSessions.map((row) => String(row["id"] ?? "")))
        .size,
      verifiedActiveMs: mergedDuration(
        intervals.filter((interval) => interval.actorUserId === actorUserId),
      ),
      eventCounts: eventCounts(actorEvents),
    };
  });

  const failureCount = input.failures.reduce(
    (sum, row) => sum + Math.max(0, Number(row["event_count"] ?? 0)),
    0,
  );
  const telemetryPathObserved =
    windowEvents.length > 0 || input.sessions.length > 0;
  const reportState: PilotReportState = outsideCohort.length
    ? "ATTRIBUTION_ANOMALY"
    : failureCount > 0 || !telemetryPathObserved
      ? "INCOMPLETE_TELEMETRY"
      : windowEvents.length === 0
        ? "VERIFIED_ZERO_ACTIVITY"
        : "VERIFIED_COMPLETE";

  return {
    reportState,
    window: { start: input.windowStart, end: input.windowEnd },
    assignedParticipantCount: assigned.size,
    authenticatedUserCount: users.filter((user) => user.authenticated).length,
    activeUserCount: users.filter((user) => user.active).length,
    inactiveAssignedUserCount: users.filter((user) => !user.active).length,
    verifiedActiveMs: users.reduce(
      (sum, user) => sum + user.verifiedActiveMs,
      0,
    ),
    feedbackSubmissionCount: input.feedback.length,
    failedEventCount: failureCount,
    outsideCohortActors: outsideCohort,
    users,
    eventCounts: eventCounts(windowEvents),
    telemetryHealth: {
      complete:
        reportState === "VERIFIED_COMPLETE" ||
        reportState === "VERIFIED_ZERO_ACTIVITY",
      telemetryPathObserved,
      inactivityCutoffMs: ACTIVE_TIME_INACTIVITY_CUTOFF_MS,
    },
    provenance: {
      sources: [
        "pilot_memberships",
        "test_sessions",
        "test_events",
        "test_feedback",
        "activity_ingest_failures",
      ],
      eventTypes: Object.keys(eventCounts(windowEvents)).sort(),
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
    },
  };
}
