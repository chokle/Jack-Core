import { describe, expect, it } from "vitest";
import {
  ACTIVE_TIME_INACTIVITY_CUTOFF_MS,
  buildPilotEndOfDayReport,
} from "../pilot-end-of-day-report.js";

const START = "2026-08-12T00:00:00.000Z";
const END = "2026-08-13T00:00:00.000Z";

function event(
  actor: string,
  appSession: string,
  minute: number,
  metadata?: Record<string, unknown>,
  eventId = `${actor}-${appSession}-${minute}-${metadata ? "heartbeat" : "feature"}`,
) {
  return {
    event_id: eventId,
    actor_user_id: actor,
    app_session_id: appSession,
    event_type: metadata ? "activity_heartbeat" : "feature_viewed",
    occurred_at: new Date(Date.parse(START) + minute * 60_000).toISOString(),
    metadata: metadata ?? { feature: "library" },
  };
}

function report(
  overrides: Partial<Parameters<typeof buildPilotEndOfDayReport>[0]> = {},
) {
  return buildPilotEndOfDayReport({
    windowStart: START,
    windowEnd: END,
    memberships: [{ user_id: "user-1", role: "tester", active: true }],
    sessions: [{ id: "session-1", actor_user_id: "user-1" }],
    events: [],
    feedback: [],
    failures: [],
    telemetryHealth: {
      windowStart: START,
      windowEnd: END,
      status: "healthy",
    },
    ...overrides,
  });
}

describe("pilot end-of-day report", () => {
  it("counts only foreground meaningful activity and applies the inactivity cutoff", () => {
    const result = report({
      events: [
        event("user-1", "tab-1", 0, {
          visibility: "foreground",
          meaningful_activity: true,
        }),
        event("user-1", "tab-1", 4, {
          visibility: "foreground",
          meaningful_activity: true,
        }),
        event("user-1", "tab-1", 5, {
          visibility: "hidden",
          meaningful_activity: true,
        }),
        event("user-1", "tab-1", 6, {
          visibility: "foreground",
          meaningful_activity: false,
        }),
        event("user-1", "tab-1", 12, {
          visibility: "foreground",
          meaningful_activity: true,
        }),
      ],
    });
    expect(ACTIVE_TIME_INACTIVITY_CUTOFF_MS).toBe(300_000);
    expect(result.users[0]?.verifiedActiveMs).toBe(240_000);
  });

  it("merges overlapping tab intervals and ignores duplicate heartbeat timestamps", () => {
    const result = report({
      events: [
        event("user-1", "tab-1", 0, {
          visibility: "foreground",
          meaningful_activity: true,
        }),
        event("user-1", "tab-1", 4, {
          visibility: "foreground",
          meaningful_activity: true,
        }),
        event("user-1", "tab-2", 2, {
          visibility: "foreground",
          meaningful_activity: true,
        }),
        event("user-1", "tab-2", 4, {
          visibility: "foreground",
          meaningful_activity: true,
        }),
        event("user-1", "tab-2", 4, {
          visibility: "foreground",
          meaningful_activity: true,
        }),
        event("user-1", "tab-2", 6, {
          visibility: "foreground",
          meaningful_activity: true,
        }),
      ],
    });
    expect(result.users[0]?.verifiedActiveMs).toBe(360_000);
  });

  it("counts non-heartbeat surfaces without treating them as active duration", () => {
    const result = report({ events: [event("user-1", "tab-1", 1)] });
    expect(result.users[0]?.eventCounts).toEqual({ feature_viewed: 1 });
    expect(result.users[0]?.verifiedActiveMs).toBe(0);
  });

  it("does not claim verified zero when the telemetry path was not observed", () => {
    expect(
      report({ sessions: [], events: [], telemetryHealth: null }).reportState,
    ).toBe("INCOMPLETE_TELEMETRY");
    expect(
      report({
        sessions: [{ id: "session-1", actor_user_id: "user-1" }],
        events: [],
      }).reportState,
    ).toBe("VERIFIED_ZERO_ACTIVITY");
    expect(
      report({
        sessions: [
          {
            id: "old-session",
            actor_user_id: "user-1",
            started_at: "2026-08-01T00:00:00.000Z",
          },
        ],
        events: [],
        telemetryHealth: null,
      }).reportState,
    ).toBe("INCOMPLETE_TELEMETRY");
  });

  it("uses a hidden heartbeat as health evidence without inventing activity", () => {
    const result = report({
      events: [
        event("user-1", "tab-1", 1, {
          visibility: "hidden",
          meaningful_activity: false,
        }),
      ],
    });
    expect(result.reportState).toBe("VERIFIED_ZERO_ACTIVITY");
    expect(result.activeUserCount).toBe(0);
    expect(result.verifiedActiveMs).toBe(0);
  });

  it("deduplicates stable event IDs before every aggregate", () => {
    const heartbeat1 = event("user-1", "tab-1", 0, {
      visibility: "foreground",
      meaningful_activity: true,
    });
    const heartbeat2 = event("user-1", "tab-1", 4, {
      visibility: "foreground",
      meaningful_activity: true,
    });
    const unique = report({ events: [heartbeat1, heartbeat2] });
    const duplicated = report({
      events: [heartbeat1, { ...heartbeat1 }, heartbeat2, { ...heartbeat2 }],
    });
    expect(duplicated).toEqual(unique);
  });

  it("reports ingestion failures and outside-cohort attribution deterministically", () => {
    expect(report({ failures: [{ event_count: 2 }] }).reportState).toBe(
      "INCOMPLETE_TELEMETRY",
    );
    const anomaly = report({ events: [event("other-user", "tab-1", 1)] });
    expect(anomaly.reportState).toBe("ATTRIBUTION_ANOMALY");
    expect(anomaly.outsideCohortActors).toEqual(["other-user"]);
  });
});
