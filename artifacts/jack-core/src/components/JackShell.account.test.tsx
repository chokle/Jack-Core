// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { JackShell } from "./JackShell";
import type { GraphModel } from "../lib/memory-graph";
import {
  resolveJackLocalAction,
  resolveJackLocalCommand,
} from "../lib/jack-local-command";

vi.mock("./SystemHealthWidget", () => ({ SystemHealthWidget: () => null }));

const model = {
  counts: { nodes: 0, connections: 0, knowledge: 0, topics: 0 },
} as GraphModel;

describe("JackShell account management", () => {
  afterEach(cleanup);

  it.each([
    "graph",
    "library",
    "interview",
    "review",
    "reports",
    "closeout",
  ] as const)(
    "opens account settings by voice from %s with the menu closed",
    (active) => {
      const onOpenSettings = vi.fn();
      render(
        <JackShell
          active={active}
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
      // Reproduce a mobile menu that is not available to DOM action lookup.
      document.querySelector("aside")!.style.display = "none";
      const command = resolveJackLocalCommand("navigate to account settings");
      expect(command).toMatchObject({ kind: "app", action: "account" });
      const action = resolveJackLocalAction(command!);
      expect(action).not.toBeNull();
      fireEvent.click(action!);
      expect(onOpenSettings).toHaveBeenCalledOnce();
    },
  );

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

  it("exposes invitation management only with a server-authorized handler", () => {
    const invite = vi.fn();
    const props = {
      active: "graph" as const,
      onNavigate: vi.fn(),
      onOpenChat: vi.fn(),
      model,
      readyCount: 0,
      lastUpdatedLabel: "now",
    };
    const result = render(
      <JackShell {...props}>
        <div />
      </JackShell>,
    );
    expect(screen.queryByTestId("invite-users")).toBeNull();
    result.rerender(
      <JackShell {...props} onInviteUsers={invite}>
        <div />
      </JackShell>,
    );
    fireEvent.click(screen.getByTestId("invite-users"));
    expect(invite).toHaveBeenCalledOnce();
  });
});
