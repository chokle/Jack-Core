// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { StructuredAnswer } from "./StructuredAnswer";
afterEach(cleanup);
it.each([
  { startTime: 0, endTime: 0, label: "Open video", seek: undefined },
  { startTime: 80, endTime: 89, label: "Jump to Clip", seek: 80 },
  { startTime: 0, endTime: 9, label: "Jump to Clip", seek: 0 },
])(
  "opens saved evidence using the available timestamp range $startTime-$endTime",
  ({ startTime, endTime, label, seek }) => {
    const open = vi.fn();
    render(
      <StructuredAnswer
        content="Saved video explanation."
        citations={[
          {
            sourceType: "video",
            videoId: "e3",
            videoTitle: "EMT Offset",
            startTime,
            endTime,
            text: "Saved evidence",
            thumbnailUrl: null,
          },
        ]}
        onCitationClick={open}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(open).toHaveBeenCalledWith("e3", seek);
    if (seek === undefined) {
      expect(screen.getByText("Video analysis")).toBeTruthy();
      expect(screen.queryByText(/0:00/)).toBeNull();
    }
  },
);
