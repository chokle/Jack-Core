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
          status: state === "submitted" ? "submitted" : "draft",
          submittedAt:
            state === "submitted" ? "2026-07-25T12:00:00.000Z" : null,
          createdAt: "2026-07-25T10:00:00.000Z",
          updatedAt: "2026-07-25T10:05:00.000Z",
        },
});

beforeEach(() => {
  state = "not_started";
  storedAnswers = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/testing/closeouts") && init?.method === "POST") {
        const body = JSON.parse(init.body as string) as {
          status: "draft" | "submitted";
          answers: Record<string, string>;
        };
        state = body.status === "submitted" ? "submitted" : "draft";
        storedAnswers = body.answers;
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
});
