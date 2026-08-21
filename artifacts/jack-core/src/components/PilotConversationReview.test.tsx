// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { PilotConversationReview } from "./PilotConversationReview";

describe("PilotConversationReview", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("requests only the supplied scope and renders participant, timestamps, content, and citations", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          conversations: [
            {
              participantId: "tester-1",
              askedAt: "2026-08-11T10:00:00.000Z",
              respondedAt: "2026-08-11T10:00:01.000Z",
              question: "How do I set this up?",
              response: "Start with the fixture.",
              citations: [{ videoTitle: "Fixture setup", startTime: 12 }],
            },
          ],
          truncated: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    render(
      <PilotConversationReview organizationId="org-1" pilotId="pilot-1" />,
    );

    await waitFor(() =>
      expect(screen.getByText("How do I set this up?")).toBeTruthy(),
    );
    expect(screen.getByText("Start with the fixture.")).toBeTruthy();
    expect(screen.getByText(/Fixture setup at 12s/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/testing/conversation-review?organizationId=org-1&pilotId=pilot-1",
      { credentials: "include" },
    );
  });
});
