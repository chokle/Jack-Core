// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { EndOfShiftCloseout } from "./EndOfShiftCloseout";

const closeoutPayload = {
  scope: {
    actorUserId: "participant-1",
    organizationId: "11111111-1111-4111-8111-111111111111",
    pilotId: "22222222-2222-4222-8222-222222222222",
  },
  shift: "day",
  workDate: "2026-07-25",
  availableQuestions: [
    "tasksCompleted",
    "safetyConcerns",
    "handoverReadiness",
    "teamCoordination",
    "materialAndTools",
    "nextShiftPriorities",
  ],
};

let state: "not_started" | "draft" | "submitted" = "not_started";
let storedAnswers: Record<string, string> = {};
let originalAnswers: Record<string, string> = {};
let corrections: Array<{
  at: string;
  reason: string;
  answers: Record<string, string>;
}> = [];
let updatedAt = "2026-07-25T10:05:00.000Z";

const draftResponse = () => ({
  ...closeoutPayload,
  state,
  crew: "Crew A",
  trade: "Electrical",
  closeout:
    state === "not_started"
      ? null
      : {
          id: "closeout-1",
          actorUserId: "participant-1",
          organizationId: "11111111-1111-4111-8111-111111111111",
          pilotId: "22222222-2222-4222-8222-222222222222",
          workDate: "2026-07-25",
          shift: "day",
          crew: "Crew A",
          trade: "Electrical",
          answers: storedAnswers,
          originalAnswers,
          corrections,
          status: state === "submitted" ? "submitted" : "draft",
          submittedAt:
            state === "submitted" ? "2026-07-25T12:00:00.000Z" : null,
          createdAt: "2026-07-25T10:00:00.000Z",
          updatedAt,
        },
});

beforeEach(() => {
  state = "not_started";
  storedAnswers = {};
  originalAnswers = {};
  corrections = [];
  updatedAt = "2026-07-25T10:05:00.000Z";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/corrections") && init?.method === "POST") {
        const body = JSON.parse(init.body as string) as {
          answers: Record<string, string>;
          reason: string;
        };
        storedAnswers = body.answers;
        corrections.push({
          at: "2026-07-25T12:30:00.000Z",
          reason: body.reason,
          answers: body.answers,
        });
        updatedAt = "2026-07-25T12:30:00.000Z";
        return new Response(
          JSON.stringify({ state, closeout: draftResponse().closeout }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      if (url.startsWith("/api/testing/closeouts") && init?.method === "POST") {
        const body = JSON.parse(init.body as string) as {
          status: "draft" | "submitted";
          answers: Record<string, string>;
        };
        state = body.status === "submitted" ? "submitted" : "draft";
        storedAnswers = body.answers;
        if (state === "submitted") originalAnswers = body.answers;
        return new Response(
          JSON.stringify({
            state,
            closeout: draftResponse().closeout,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.startsWith("/api/testing/closeouts")) {
        return new Response(JSON.stringify(draftResponse()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected request ${url}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("EndOfShiftCloseout", () => {
  it("saves and submits through draft + final states", async () => {
    render(
      <EndOfShiftCloseout
        participantId="participant-1"
        participantName="Pilot One"
        organizationName="Test Org"
        pilotName="Test Pilot"
      />,
    );

    expect(
      await screen.findByText("Closeout status: Not started"),
    ).toBeTruthy();
    // Exact label queries keep the participant-facing accessible names stable.
    const complete = [
      ["What tasks were completed today?", "Task A completed"],
      ["Any safety concerns or incidents?", "No incidents"],
      ["Are you ready for handover?", "Yes"],
      ["How was team coordination?", "Good"],
      ["Any missing materials or tools?", "None"],
      ["What should next shift focus on?", "Prep for morning startup"],
    ] as const;
    for (const [label, value] of complete) {
      fireEvent.change(await screen.findByLabelText(label), {
        target: { value },
      });
    }

    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(screen.getByText("Draft saved.")).toBeTruthy());
    expect(state).toBe("draft");

    fireEvent.click(screen.getByRole("button", { name: "Submit closeout" }));
    await waitFor(() =>
      expect(screen.getByText("Closeout submitted.")).toBeTruthy(),
    );
    expect(state).toBe("submitted");
    expect(screen.getByText(/Closeout status: Submitted/)).toBeTruthy();
  });

  it("restores a previously saved draft", async () => {
    state = "draft";
    storedAnswers = {
      tasksCompleted: "Baseline notes",
      safetyConcerns: "None",
      handoverReadiness: "Ready",
      teamCoordination: "Aligned",
      materialAndTools: "Needs extra gloves",
      nextShiftPriorities: "No high priority",
    };
    render(
      <EndOfShiftCloseout
        participantId="participant-1"
        participantName="Pilot One"
        organizationName="Test Org"
        pilotName="Test Pilot"
      />,
    );

    expect(await screen.findByText("Closeout status: Draft")).toBeTruthy();
    fireEvent.change(
      await screen.findByLabelText("What tasks were completed today?"),
      {
        target: { value: "edited answer" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    expect(screen.getByDisplayValue("Baseline notes")).toBeTruthy();
  });

  it("lets a participant correct a submitted closeout and shows its history", async () => {
    state = "submitted";
    storedAnswers = {
      tasksCompleted: "Original task",
      safetyConcerns: "None",
      handoverReadiness: "Ready",
      teamCoordination: "Aligned",
      materialAndTools: "No missing tools",
      nextShiftPriorities: "Morning checks",
    };
    originalAnswers = { ...storedAnswers };
    render(<EndOfShiftCloseout participantId="participant-1" />);
    expect(await screen.findByText("Closeout status: Submitted")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Correct submitted closeout" }),
    );
    fireEvent.change(screen.getByLabelText("Any missing materials or tools?"), {
      target: { value: "One missing wrench" },
    });
    fireEvent.change(screen.getByLabelText("Reason for correction"), {
      target: { value: "Found after handover" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
    expect(await screen.findByText(/Correction saved/)).toBeTruthy();
    expect(screen.getByDisplayValue("One missing wrench")).toBeTruthy();
    expect(screen.getByText(/Submission history \(2\)/)).toBeTruthy();
    expect(corrections).toHaveLength(1);
  });
});
