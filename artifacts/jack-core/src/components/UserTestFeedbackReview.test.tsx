// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UserTestFeedbackReview } from "./UserTestFeedbackReview";

const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

const record = {
  id: "11111111-1111-4111-8111-111111111111",
  testerEmail: "tester@example.test",
  testerName: "Taylor Tester",
  testerProfileId: null,
  trade: "Electrical",
  featuresUsed: ["ask_jack", "memory_graph"],
  deviceCategory: "desktop",
  trigger: "logout",
  goal: "Find a safe procedure",
  usefulness: "partly",
  shortfall: "Needed clearer sourcing",
  adoptionNeed: "More Canadian examples",
  additional: "Written pilot feedback",
  status: "new",
  adminNotes: null,
  reviewedBy: null,
  reviewedAt: null,
  notificationStatus: "failed",
  notificationAttempts: 1,
  notificationLastError: "email_provider_not_configured",
  notificationSentAt: null,
  createdAt: "2026-07-23T12:00:00.000Z",
};

describe("UserTestFeedbackReview", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/app?view=review");
    toast.mockReset();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "PATCH") {
          return new Response(
            JSON.stringify({
              ...record,
              status: "actioned",
              adminNotes: "Added to backlog",
              reviewedBy: "Admin Reviewer",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.startsWith("/api/testing/feedback?")) {
          return new Response(
            JSON.stringify({
              feedback: [record],
              unreadCount: 1,
              trades: ["Electrical"],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        throw new Error(`Unexpected request ${url}`);
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows unread count, filters, detail, delivery failure, and saves review state", async () => {
    render(<UserTestFeedbackReview />);

    expect(await screen.findByText("Taylor Tester")).toBeTruthy();
    expect(screen.getByLabelText("1 new feedback records")).toBeTruthy();
    expect(screen.getByLabelText("Filter feedback by trade")).toBeTruthy();
    expect(screen.getByLabelText("Filter feedback by status")).toBeTruthy();
    expect(screen.getByLabelText("Filter feedback by response")).toBeTruthy();
    expect(screen.getByLabelText("Filter feedback from date")).toBeTruthy();
    expect(screen.getByLabelText("Filter feedback to date")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Filter feedback by status"), {
      target: { value: "new" },
    });
    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("status=new"))).toBe(
        true,
      ),
    );

    fireEvent.click(screen.getByText("Taylor Tester"));
    expect(await screen.findByText("Written pilot feedback")).toBeTruthy();
    expect(screen.getByText(/Email Provider Not Configured/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Feedback review status"), {
      target: { value: "actioned" },
    });
    fireEvent.change(screen.getByLabelText("Feedback admin notes"), {
      target: { value: "Added to backlog" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save review" }));

    await waitFor(() =>
      expect(
        vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "PATCH"),
      ).toBe(true),
    );
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Feedback updated" }),
    );
  });
});
