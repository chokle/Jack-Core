// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./UserTestFeedbackReview", () => ({
  UserTestFeedbackReview: () => <div data-testid="feedback-review" />,
}));

import { PilotActivityReports } from "./PilotActivityReports";

const scope = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  pilotId: "22222222-2222-4222-8222-222222222222",
  organizationName: "Test Org",
  pilotName: "Test Pilot",
  authority: "pilot_admin",
};

function endOfDay(reportState: string) {
  return {
    report: {
      reportState,
      window: {
        start: "2026-08-12T00:00:00.000Z",
        end: "2026-08-13T00:00:00.000Z",
      },
      assignedParticipantCount: 2,
      authenticatedUserCount: 1,
      activeUserCount: reportState === "VERIFIED_ZERO_ACTIVITY" ? 0 : 1,
      inactiveAssignedUserCount: 1,
      verifiedActiveMs: reportState === "VERIFIED_ZERO_ACTIVITY" ? 0 : 360_000,
      feedbackSubmissionCount: 1,
      failedEventCount: reportState === "INCOMPLETE_TELEMETRY" ? 1 : 0,
      outsideCohortActors:
        reportState === "ATTRIBUTION_ANOMALY" ? ["outside-user"] : [],
      users: [
        {
          actorUserId: "tester-1",
          authenticated: true,
          active: reportState !== "VERIFIED_ZERO_ACTIVITY",
          firstActivityAt: "2026-08-12T01:00:00.000Z",
          lastActivityAt: "2026-08-12T01:06:00.000Z",
          sessionCount: 1,
          verifiedActiveMs:
            reportState === "VERIFIED_ZERO_ACTIVITY" ? 0 : 360_000,
          eventCounts: { activity_heartbeat: 7 },
        },
      ],
      telemetryHealth: {
        complete: reportState !== "INCOMPLETE_TELEMETRY",
        telemetryPathObserved: true,
        malformedEventCount: 0,
        inactivityCutoffMs: 300_000,
      },
      provenance: {
        sources: ["pilot_memberships", "test_sessions", "test_events"],
        eventTypes: ["activity_heartbeat"],
        windowStart: "2026-08-12T00:00:00.000Z",
        windowEnd: "2026-08-13T00:00:00.000Z",
      },
    },
    generatedAt: "2026-08-13T00:05:00.000Z",
  };
}

function ok(body: unknown) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

async function renderReport(state: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/testing/reports/scopes") return ok({ scopes: [scope] });
      if (url.includes("/api/testing/reports/summary?")) {
        return ok({
          summary: {
            participantCount: 0,
            sessionCount: 0,
            completedSessions: 0,
            completionRate: 0,
            onboardingCompletionRate: 0,
            recordingOptInRate: 0,
            feedbackCount: 0,
            droppedEventCount: 0,
            rejectedEventCount: 0,
            eventCounts: {},
          },
          users: [],
          generatedAt: "2026-08-13T00:00:00.000Z",
        });
      }
      if (url.includes("/api/testing/reports/end-of-day?"))
        return ok(endOfDay(state));
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  render(<PilotActivityReports />);
  const load = await screen.findByRole("button", {
    name: "Load end-of-day report",
  });
  fireEvent.change(screen.getByLabelText("End-of-day report date (UTC)"), {
    target: { value: "2026-08-12" },
  });
  fireEvent.click(load);
  await screen.findByTestId("end-of-day-report");
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("pilot end-of-day report UI", () => {
  it("renders incomplete telemetry without presenting totals as certified", async () => {
    await renderReport("INCOMPLETE_TELEMETRY");
    expect(screen.getByText("Incomplete telemetry")).toBeTruthy();
    expect(screen.getByText(/totals are not certified complete/i)).toBeTruthy();
  });

  it("renders verified zero activity explicitly", async () => {
    await renderReport("VERIFIED_ZERO_ACTIVITY");
    expect(screen.getByText("Verified zero activity")).toBeTruthy();
    expect(screen.getAllByText("0m").length).toBeGreaterThan(0);
  });

  it("renders attribution anomalies and source traceability", async () => {
    await renderReport("ATTRIBUTION_ANOMALY");
    expect(screen.getByText("Attribution anomaly")).toBeTruthy();
    expect(screen.getByText(/outside-user/)).toBeTruthy();
    fireEvent.click(screen.getByText("Telemetry traceability"));
    await waitFor(() => {
      expect(
        screen.getByText(/pilot_memberships, test_sessions, test_events/),
      ).toBeTruthy();
      expect(screen.getByText("activity_heartbeat")).toBeTruthy();
      expect(screen.getByText(/2026-08-12T00:00:00.000Z/)).toBeTruthy();
    });
  });

  it("clears a loaded report immediately when the requested date changes", async () => {
    await renderReport("VERIFIED_ZERO_ACTIVITY");
    expect(screen.getByTestId("end-of-day-report")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("End-of-day report date (UTC)"), {
      target: { value: "2026-08-11" },
    });
    expect(screen.queryByTestId("end-of-day-report")).toBeNull();
  });

  it("does not retain stale totals after a failed reload", async () => {
    await renderReport("VERIFIED_ZERO_ACTIVITY");
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/testing/reports/end-of-day?")) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: "Telemetry unavailable." }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Load end-of-day report" }),
    );
    expect(screen.queryByTestId("end-of-day-report")).toBeNull();
    expect(await screen.findByText("Telemetry unavailable.")).toBeTruthy();
  });
});
