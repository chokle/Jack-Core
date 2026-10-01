// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { buildJackPresenceState, JackPresence } from "./JackPresence";

afterEach(cleanup);

describe("Jack presence", () => {
  it("reflects the active workspace and available Living Memory", () => {
    const state = buildJackPresenceState({
      workspace: "Living Memory",
      memoryLoading: false,
      memoryError: false,
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
        memoryError: false,
        askJackOpen: true,
      }).status,
    ).toBe("ONLINE");
    expect(
      buildJackPresenceState({
        workspace: "Living Memory",
        memoryLoading: true,
        memoryError: false,
        askJackOpen: false,
      }).status,
    ).toBe("THINKING");
  });

  it("reports Living Memory failures instead of false availability", () => {
    const state = buildJackPresenceState({
      workspace: "Living Memory",
      memoryLoading: false,
      memoryError: true,
      askJackOpen: false,
    });

    render(<JackPresence state={state} />);
    expect(
      screen.getByLabelText("Jack presence").getAttribute("data-status"),
    ).toBe("error");
    expect(screen.getByText("Unavailable")).toBeTruthy();
    expect(screen.queryByText("Living · available")).toBeNull();
  });

  it("only displays a source count when the caller has verified one", () => {
    const state = buildJackPresenceState({
      workspace: "Library",
      memoryLoading: false,
      memoryError: false,
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
      memoryError: false,
      askJackOpen: false,
    });
    render(<JackPresence state={state} />);
    expect(screen.getByText("Radio Jack")).toBeTruthy();
    expect(screen.queryByText("ACTIVE")).toBeNull();
  });
});
