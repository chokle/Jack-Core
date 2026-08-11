// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Citation } from "@workspace/api-client-react";
import { StructuredAnswer } from "./StructuredAnswer";

afterEach(cleanup);

function authorityCitation(officialSourceUrl: string): Citation {
  return {
    videoId: "",
    videoTitle: "Official authority source",
    startTime: 0,
    endTime: 0,
    text: "",
    sourceType: "authority",
    officialSourceUrl,
  };
}

describe("StructuredAnswer official source URL safety", () => {
  it.each(["javascript:alert(1)", "data:text/html,unsafe", "not a URL"])(
    "does not render an external link for %s",
    (officialSourceUrl) => {
      render(
        <StructuredAnswer
          content="Authority guidance"
          citations={[authorityCitation(officialSourceUrl)]}
          onCitationClick={vi.fn()}
        />,
      );

      expect(
        screen.queryByRole("link", { name: "Open official source" }),
      ).toBeNull();
    },
  );

  it("renders a valid HTTPS official source as an external link", () => {
    const officialSourceUrl = "https://example.gov/official-source";
    render(
      <StructuredAnswer
        content="Authority guidance"
        citations={[authorityCitation(officialSourceUrl)]}
        onCitationClick={vi.fn()}
      />,
    );

    expect(
      screen
        .getByRole("link", { name: "Open official source" })
        .getAttribute("href"),
    ).toBe(officialSourceUrl);
  });
});
