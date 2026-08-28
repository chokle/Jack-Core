// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { Landing } from "./Landing";

afterEach(() => cleanup());

describe("Landing pilot access gateway", () => {
  it("keeps the real pilot app behind sign-in and offers an isolated public demo", () => {
    render(<Landing />);

    expect(
      screen.getByText("Jack is currently running a controlled field pilot."),
    ).toBeTruthy();
    expect(
      screen.getByText(/contains no live crew, company, or site data/i),
    ).toBeTruthy();

    const pilotLink = screen.getByRole("link", {
      name: /pilot participant — open jack/i,
    });
    expect(pilotLink.getAttribute("href")).toBe("/sign-in");

    const demoLinks = screen.getAllByRole("link", { name: /try (jack )?demo/i });
    expect(demoLinks.length).toBeGreaterThan(0);
    for (const link of demoLinks) {
      expect(link.getAttribute("href")).toBe(
        "https://jack-core-demo-ycf4yh.v2.appdeploy.ai/",
      );
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toContain("noreferrer");
    }

    expect(screen.queryByRole("link", { name: /get started/i })).toBeNull();
  });
});
