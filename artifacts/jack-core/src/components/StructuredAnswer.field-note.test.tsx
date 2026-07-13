// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StructuredAnswer } from "./StructuredAnswer";

afterEach(cleanup);

describe("StructuredAnswer Field Note handoff", () => {
  it("opens the selected Field Note in Interview Mode", () => {
    const onFieldNoteClick = vi.fn();
    render(
      <StructuredAnswer
        content="A field note answer"
        citations={[{
          videoId: "",
          videoTitle: "Welding Positions",
          startTime: 0,
          endTime: 0,
          text: "Practice all positions to build job readiness.",
          sourceType: "knowledge",
          entryId: "note-welding-positions",
        }]}
        onCitationClick={vi.fn()}
        onFieldNoteClick={onFieldNoteClick}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Discuss Welding Positions in Interview Mode/i }));
    expect(onFieldNoteClick).toHaveBeenCalledWith(expect.objectContaining({
      entryId: "note-welding-positions",
      videoTitle: "Welding Positions",
    }));
  });
});
