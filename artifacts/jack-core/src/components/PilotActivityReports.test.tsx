// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { PilotActivityReports } from "./PilotActivityReports";

vi.mock("./PilotConversationReview", () => ({
  PilotConversationReview: () => null,
}));
vi.mock("./UserTestFeedbackReview", () => ({
  UserTestFeedbackReview: () => null,
}));

const scope = {
  organizationId: "org-1",
  pilotId: "pilot-1",
  organizationName: "Org",
  pilotName: "Pilot",
  authority: "pilot_admin",
};

function summary(
  chatActivityEvidence:
    | { status: "available" }
    | { status: "unavailable"; reason: "schema_capability_missing" },
) {
  const available = chatActivityEvidence.status === "available";
  return {
    summary: {
      aggregateUnit: "sessions",
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
    participants: [],
    sessions: [],
    reconciliation: {
      enrolledTesterIds: ["tester-1"],
      observedSessionActorIds: [],
      sessionCountsByActor: { "tester-1": 0 },
      chatActivityEvidence,
      chatActivityCountsByActor: available ? { "tester-1": 0 } : null,
      likelyMismatches: {
        observedNotEnrolled: [],
        enrolledWithoutSessionEvidence: ["tester-1"],
        enrolledWithoutActivity: available ? ["tester-1"] : null,
      },
    },
    generatedAt: "2026-08-13T00:00:00.000Z",
  };
}

function mockReport(report: ReturnType<typeof summary>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    const body = url.endsWith("/api/testing/reports/scopes")
      ? { scopes: [scope] }
      : report;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

describe("PilotActivityReports identity reconciliation", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders unavailable chat evidence without claiming inactivity", async () => {
    mockReport(
      summary({
        status: "unavailable",
        reason: "schema_capability_missing",
      }),
    );

    render(<PilotActivityReports />);

    await waitFor(() =>
      expect(screen.getByText("No session evidence")).toBeTruthy(),
    );
    expect(screen.getByText("Unavailable")).toBeTruthy();
    expect(
      screen.getByText(/Chat activity evidence is unavailable/),
    ).toBeTruthy();
    expect(screen.queryByText("No observed activity")).toBeNull();
    expect(
      screen.getByText(/Chat content is never loaded or shown/),
    ).toBeTruthy();
  });

  it("claims no observed activity only when chat counts are available", async () => {
    mockReport(summary({ status: "available" }));

    render(<PilotActivityReports />);

    await waitFor(() =>
      expect(screen.getByText("No observed activity")).toBeTruthy(),
    );
    expect(screen.queryByText("No session evidence")).toBeNull();
    expect(screen.queryByText("Unavailable")).toBeNull();
  });
});
