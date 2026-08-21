// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PilotActivityReports } from "./PilotActivityReports";

const scopeOne = {
  organizationId: "org-11111111-1111-4111-8111-111111111111",
  pilotId: "pilot-11111111-1111-4111-8111-111111111111",
  organizationName: "Torch Plumbing",
  pilotName: "Rob plumbing",
  authority: "org_admin",
};

const scopeTwo = {
  organizationId: "org-22222222-2222-4222-8222-222222222222",
  pilotId: "pilot-22222222-2222-4222-8222-222222222222",
  organizationName: "Pipeworks",
  pilotName: "Ace repair",
  authority: "org_admin",
};

const baseScopeResponse = {
  scopes: [scopeOne, scopeTwo],
};

const closeoutResponse = {
  scope: {
    organizationId: scopeOne.organizationId,
    pilotId: scopeOne.pilotId,
  },
  closeouts: [],
  limit: 25,
  count: 0,
  truncated: false,
};

const baseProgressResponse = { testers: [] };
const baseFeedbackResponse = { feedback: [], unreadCount: 0, trades: [] };

function withJson(body: unknown, options: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...options,
  });
}

function summaryResponse(
  generatedAt: string,
  participantCount: number,
  userTag: string,
) {
  return {
    summary: {
      participantCount,
      sessionCount: 1,
      completedSessions: 0,
      completionRate: 0,
      onboardingCompletionRate: 0,
      recordingOptInRate: 0,
      feedbackCount: 0,
      droppedEventCount: 0,
      rejectedEventCount: 0,
      eventCounts: {},
    },
    users: [
      {
        id: `session-${userTag}`,
        actorUserId: `tester-${userTag}`,
        status: "active",
        startedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        onboardingStatus: "in_progress",
        questionCount: 1,
        recordingStatus: "not_started",
        feedbackStatus: "not_started",
        errorCount: 0,
      },
    ],
    generatedAt,
  };
}

function requestUrl(input: RequestInfo | URL) {
  return new URL(String(input), "http://localhost");
}

function createSummaryByQuery(summaryCalls: {
  count: number;
}): (request: URL) => ReturnType<typeof summaryResponse> {
  return (request) => {
    const pilotId = request.searchParams.get("pilotId");
    summaryCalls.count += 1;
    const isScopeOne = pilotId === scopeOne.pilotId;

    return summaryResponse(
      `2026-08-09T00:00:${String(summaryCalls.count).padStart(2, "0")}.000Z`,
      isScopeOne ? 1 : 2,
      isScopeOne ? "one" : "two",
    );
  };
}

function makeSummaryMock(
  summaryCalls: { count: number },
  handlers: {
    onSummary?: (request: URL) => Response | Promise<Response>;
    onScopes?: Response | Promise<Response>;
    onCloseouts?: Response | Promise<Response>;
    onFeedback?: Response | Promise<Response>;
    onProgress?: Response | Promise<Response>;
  } = {},
) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const request = requestUrl(input);
    const path = request.pathname;

    if (path === "/api/testing/reports/scopes")
      return handlers.onScopes ?? withJson(baseScopeResponse);
    if (path.startsWith("/api/testing/reports/closeouts"))
      return handlers.onCloseouts ?? withJson(closeoutResponse);
    if (path === "/api/testing/reports/summary") {
      if (handlers.onSummary) {
        return handlers.onSummary(request);
      }
      return withJson(createSummaryByQuery(summaryCalls)(request));
    }
    if (path === "/api/testing/feedback")
      return handlers.onFeedback ?? withJson(baseFeedbackResponse);
    if (path.startsWith("/api/testing/feedback/"))
      return handlers.onFeedback ?? withJson(baseFeedbackResponse);
    if (path === "/api/testing/progress")
      return handlers.onProgress ?? withJson(baseProgressResponse);

    return new Response(
      JSON.stringify({ message: `Unexpected request ${path}` }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  });
}

function createDeferredResponse() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((resolveValue) => {
    resolve = resolveValue;
  });
  return { promise, resolve };
}

async function settleAfterRender() {
  await vi.runAllTicks();
  await vi.advanceTimersByTimeAsync(0);
}

function setVisibility(value: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => value,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

async function waitForSummaryCall(
  summaryCalls: { count: number },
  target: number,
  stepMs = 10,
  iterations = 120,
) {
  for (let i = 0; i < iterations; i += 1) {
    if (summaryCalls.count >= target) return;
    await vi.advanceTimersByTimeAsync(stepMs);
    await vi.runAllTicks();
  }
  expect(summaryCalls.count).toBeGreaterThanOrEqual(target);
}

async function waitForSelectValue(
  select: HTMLSelectElement,
  expected: string,
  stepMs = 10,
  iterations = 120,
) {
  for (let i = 0; i < iterations; i += 1) {
    if (select.value === expected) return;
    await vi.advanceTimersByTimeAsync(stepMs);
    await vi.runAllTicks();
  }
  expect(select.value).toBe(expected);
}

async function waitForText(
  text: string | RegExp,
  stepMs = 10,
  iterations = 120,
) {
  for (let i = 0; i < iterations; i += 1) {
    if (screen.queryByText(text)) return;
    await vi.advanceTimersByTimeAsync(stepMs);
    await vi.runAllTicks();
  }
  expect(screen.getByText(text)).toBeTruthy();
}

beforeEach(() => {
  window.history.replaceState({}, "", "/admin");
  setVisibility("visible");
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-09T00:00:00Z"));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("PilotActivityReports", () => {
  it("auto-polls summary on a bounded cadence while the page is visible", async () => {
    const summaryCalls = { count: 0 };
    const fetchMock = makeSummaryMock(summaryCalls);
    vi.stubGlobal("fetch", fetchMock);

    render(<PilotActivityReports />);
    expect(screen.getByText("Pilot activity reports")).toBeTruthy();
    const scopeSelect = screen.getByLabelText(
      "Organization and pilot",
    ) as HTMLSelectElement;
    await waitForSelectValue(
      scopeSelect,
      `${scopeOne.organizationId}:${scopeOne.pilotId}`,
    );
    await waitForSummaryCall(summaryCalls, 1);

    await vi.advanceTimersByTimeAsync(11_000);
    expect(summaryCalls.count).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(summaryCalls.count).toBe(2);
  });

  it("does not poll when hidden and refreshes again when visible", async () => {
    const summaryCalls = { count: 0 };
    const fetchMock = makeSummaryMock(summaryCalls);
    vi.stubGlobal("fetch", fetchMock);

    render(<PilotActivityReports />);
    expect(screen.getByText("Pilot activity reports")).toBeTruthy();
    const scopeSelect = screen.getByLabelText(
      "Organization and pilot",
    ) as HTMLSelectElement;
    await waitForSelectValue(
      scopeSelect,
      `${scopeOne.organizationId}:${scopeOne.pilotId}`,
    );
    await waitForSummaryCall(summaryCalls, 1);

    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(24_000);
    expect(summaryCalls.count).toBe(1);

    setVisibility("visible");
    await waitForSummaryCall(summaryCalls, 2);
  });

  it("prevents overlapping summary refreshes", async () => {
    const summaryCalls = { count: 0 };
    const firstSummary = createDeferredResponse();
    const fetchMock = makeSummaryMock(summaryCalls, {
      onSummary: (request) => {
        summaryCalls.count += 1;
        if (summaryCalls.count === 1) {
          return firstSummary.promise;
        }
        return withJson(summaryResponse("2026-08-09T00:00:12.000Z", 1, "one"));
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<PilotActivityReports />);
    const scopeSelect = screen.getByLabelText(
      "Organization and pilot",
    ) as HTMLSelectElement;
    await waitForSelectValue(
      scopeSelect,
      `${scopeOne.organizationId}:${scopeOne.pilotId}`,
    );
    await waitForSummaryCall(summaryCalls, 1);

    await vi.advanceTimersByTimeAsync(12_000);
    expect(summaryCalls.count).toBe(1);

    firstSummary.resolve(
      withJson(summaryResponse("2026-08-09T00:00:00.000Z", 1, "one")),
    );
    await settleAfterRender();
    expect(summaryCalls.count).toBe(1);

    await vi.advanceTimersByTimeAsync(12_000);
    expect(summaryCalls.count).toBe(2);
  });

  it("preserves successful summary data, marks stale state, and shows update errors", async () => {
    const summaryCalls = { count: 0 };
    const fetchMock = makeSummaryMock(summaryCalls, {
      onSummary: () => {
        summaryCalls.count += 1;
        if (summaryCalls.count === 1) {
          return withJson(
            summaryResponse("2026-08-09T00:00:00.000Z", 1, "one"),
          );
        }
        return new Response("down", { status: 500 });
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<PilotActivityReports />);
    expect(screen.getByText("Pilot activity reports")).toBeTruthy();
    const scopeSelect = screen.getByLabelText(
      "Organization and pilot",
    ) as HTMLSelectElement;
    await waitForSelectValue(
      scopeSelect,
      `${scopeOne.organizationId}:${scopeOne.pilotId}`,
    );
    await waitForSummaryCall(summaryCalls, 1);
    await waitForText("tester-one");

    await vi.advanceTimersByTimeAsync(12_000);
    await waitForSummaryCall(summaryCalls, 2);
    expect(screen.getByText("tester-one")).toBeTruthy();
    await waitForText(/Error on last update/);

    await vi.advanceTimersByTimeAsync(24_000);
    await waitForText(/Stale/);
  });

  it("supports immediate manual refresh", async () => {
    const summaryCalls = { count: 0 };
    const fetchMock = makeSummaryMock(summaryCalls);
    vi.stubGlobal("fetch", fetchMock);

    render(<PilotActivityReports />);
    const scopeSelect = screen.getByLabelText(
      "Organization and pilot",
    ) as HTMLSelectElement;
    await waitForSelectValue(
      scopeSelect,
      `${scopeOne.organizationId}:${scopeOne.pilotId}`,
    );
    await waitForSummaryCall(summaryCalls, 1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.runAllTicks();

    const manualRefresh = screen.getByRole("button", {
      name: /Manual refresh/i,
    });
    fireEvent.click(manualRefresh);
    await waitForSummaryCall(summaryCalls, 2);
  });

  it("refreshes immediately when scope changes", async () => {
    const summaryCalls = { count: 0 };
    const fetchMock = makeSummaryMock(summaryCalls);
    vi.stubGlobal("fetch", fetchMock);

    render(<PilotActivityReports />);
    expect(screen.getByText("Pilot activity reports")).toBeTruthy();
    const scopeSelect = screen.getByLabelText(
      "Organization and pilot",
    ) as HTMLSelectElement;
    await waitForSelectValue(
      scopeSelect,
      `${scopeOne.organizationId}:${scopeOne.pilotId}`,
    );
    await waitForSummaryCall(summaryCalls, 1);

    fireEvent.change(scopeSelect, {
      target: { value: `${scopeTwo.organizationId}:${scopeTwo.pilotId}` },
    });
    await waitForText("tester-two");
    expect(summaryCalls.count).toBe(2);
  });

  it("cleans up polling timers when unmounted", async () => {
    const summaryCalls = { count: 0 };
    const fetchMock = makeSummaryMock(summaryCalls);
    vi.stubGlobal("fetch", fetchMock);

    const { unmount } = render(<PilotActivityReports />);
    const scopeSelect = screen.getByLabelText(
      "Organization and pilot",
    ) as HTMLSelectElement;
    await waitForSelectValue(
      scopeSelect,
      `${scopeOne.organizationId}:${scopeOne.pilotId}`,
    );
    await waitForSummaryCall(summaryCalls, 1);

    unmount();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(summaryCalls.count).toBe(1);
  });
});
