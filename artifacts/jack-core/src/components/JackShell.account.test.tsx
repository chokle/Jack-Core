// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { JackShell } from "./JackShell";
import type { GraphModel } from "../lib/memory-graph";

vi.mock("./SystemHealthWidget", () => ({ SystemHealthWidget: () => null }));

const model = {
  counts: { nodes: 0, connections: 0, knowledge: 0, topics: 0 },
} as GraphModel;

describe("JackShell account management", () => {
  afterEach(cleanup);

  it("opens secure account settings from the sidebar", () => {
    const onOpenSettings = vi.fn();
    render(
      <JackShell
        active="graph"
        onNavigate={vi.fn()}
        onOpenChat={vi.fn()}
        model={model}
        readyCount={0}
        lastUpdatedLabel="now"
        onOpenSettings={onOpenSettings}
      >
        <div />
      </JackShell>,
    );

    fireEvent.click(screen.getByTestId("account-settings"));
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(screen.queryByText("Coming Soon")).toBeNull();
  });

  it("places Logout immediately after Account Settings and invokes Clerk sign-out", () => {
    const onSignOut = vi.fn();
    render(
      <JackShell
        active="graph"
        onNavigate={vi.fn()}
        onOpenChat={vi.fn()}
        model={model}
        readyCount={0}
        lastUpdatedLabel="now"
        onOpenSettings={vi.fn()}
        onSignOut={onSignOut}
      >
        <div />
      </JackShell>,
    );

    const settings = screen.getByTestId("account-settings");
    const logout = screen.getByTestId("sign-out");
    expect(settings.nextElementSibling).toBe(logout);
    expect(logout.textContent).toContain("Logout");

    fireEvent.click(logout);
    expect(onSignOut).toHaveBeenCalledOnce();
  });

  it("omits Logout when no authenticated sign-out handler is provided", () => {
    render(
      <JackShell
        active="graph"
        onNavigate={vi.fn()}
        onOpenChat={vi.fn()}
        model={model}
        readyCount={0}
        lastUpdatedLabel="now"
        onOpenSettings={vi.fn()}
      >
        <div />
      </JackShell>,
    );

    expect(screen.queryByTestId("sign-out")).toBeNull();
  });
});
