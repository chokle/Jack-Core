// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { buildJackPresenceState, JackPresence } from "./JackPresence";

describe("Jack presence", () => {
  it("reflects the active workspace and available Living Memory", () => {
    const state = buildJackPresenceState({
      workspace: "Living Memory",
      memoryLoading: false,
      askJackOpen: false,
    });

    render(<JackPresence state={state} />);
    expect(
      screen.getByLabelText("Jack presence").getAttribute("data-status"),
    ).toBe("online");
    expect(screen.getByText("Living · available")).toBeTruthy();
    expect(screen.getByText("Living Memory")).toBeTruthy();
  });

  it("does not mistake an open Ask Jack panel for an active voice session", () => {
    expect(
      buildJackPresenceState({
        workspace: "Living Memory",
        memoryLoading: false,
        askJackOpen: true,
      }).status,
    ).toBe("ONLINE");
    expect(
      buildJackPresenceState({
        workspace: "Living Memory",
        memoryLoading: true,
        askJackOpen: false,
      }).status,
    ).toBe("THINKING");
  });

  it("only displays a source count when the caller has verified one", () => {
    const state = buildJackPresenceState({
      workspace: "Library",
      memoryLoading: false,
      askJackOpen: false,
      sourceCount: 2,
    });
    render(<JackPresence state={state} />);
    expect(screen.getByText("2 cited")).toBeTruthy();
  });

  it("accepts Radio and Radar state only when provided by their owners", () => {
    const state = buildJackPresenceState({
      workspace: "Site radar",
      memoryLoading: false,
      askJackOpen: false,
    });
    render(<JackPresence state={state} />);
    expect(screen.getByText("Radio Jack")).toBeTruthy();
    expect(screen.queryByText("ACTIVE")).toBeNull();
  });
});
