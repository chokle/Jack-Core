// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { fastScanRuns, StructuredAnswer } from "./StructuredAnswer";

afterEach(cleanup);

describe("StructuredAnswer fast-scan emphasis", () => {
  it("preserves Jack's explicit bold phrases", () => {
    expect(
      fastScanRuns([
        { text: "Confirm the setup." },
        { text: "Keep the ground clamp secure.", bold: true },
      ]),
    ).toEqual([
      { text: "Confirm the setup." },
      { text: "Keep the ground clamp secure.", bold: true },
    ]);
  });

  it("automatically emphasizes a limited number of safety and action clauses", () => {
    const runs = fastScanRuns([
      {
        text: "Set the machine for the joint. Make sure the ground clamp is secure, avoid contaminated metal, and keep the work area organized. Extra context remains readable.",
      },
    ]);

    expect(runs.filter((run) => run.bold).map((run) => run.text)).toEqual([
      "Make sure the ground clamp is secure,",
      "avoid contaminated metal,",
    ]);
  });

  it("renders emphasized key points as highlighted, underlined text", () => {
    const { container } = render(
      <StructuredAnswer
        content={[
          "Use the correct setup for the joint.",
          "",
          "## Overview",
          "Make sure the ground clamp is secure, and avoid contaminated metal. Supporting context can be read when time allows.",
        ].join("\n")}
        onCitationClick={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Expand Answer" }));

    const highlights = [...container.querySelectorAll("mark")];
    expect(highlights.map((node) => node.textContent)).toEqual([
      "Make sure the ground clamp is secure,",
      "and avoid contaminated metal.",
    ]);
    for (const highlight of highlights) {
      expect(highlight.className).toContain("underline");
      expect(highlight.className).toContain("bg-primary/20");
    }
  });
});
