// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { JackShell, type JackView } from "./JackShell";
import type { GraphModel } from "../lib/memory-graph";

vi.mock("./SystemHealthWidget", () => ({ SystemHealthWidget: () => null }));

const model = {
  counts: { nodes: 0, connections: 0, knowledge: 0, topics: 0 },
} as GraphModel;

function shell(userId?: string, active: JackView = "graph") {
  return (
    <JackShell
      active={active}
      onNavigate={vi.fn()}
      onOpenChat={vi.fn()}
      model={model}
      readyCount={0}
      lastUpdatedLabel="now"
      siteHudUserId={userId}
    >
      <div>{active} content</div>
    </JackShell>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("Site HUD demo entry", () => {
  it.each([undefined, "false", "1"])(
    "stays absent unless the build flag is exactly true (%s)",
    (flag) => {
      vi.stubEnv("VITE_SITE_HUD_DEMO_ENABLED", flag);
      render(shell("demo-account"));
      expect(
        screen.queryByRole("button", { name: "Open demo site" }),
      ).toBeNull();
    },
  );

  it("requires a resolved account even when enabled", () => {
    vi.stubEnv("VITE_SITE_HUD_DEMO_ENABLED", "true");
    render(shell());
    expect(screen.queryByRole("button", { name: "Open demo site" })).toBeNull();
  });

  it("requires explicit site selection and preserves it across app surfaces", () => {
    vi.stubEnv("VITE_SITE_HUD_DEMO_ENABLED", "true");
    const { rerender } = render(shell("demo-account"));
    expect(
      screen.queryByRole("button", { name: "Close demo site" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open demo site" }));
    rerender(shell("demo-account", "library"));
    expect(
      screen.getByRole("button", { name: "Close demo site" }),
    ).toBeTruthy();
    expect(screen.getByText("library content")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close demo site" }));
    expect(screen.getByRole("button", { name: "Open demo site" })).toBeTruthy();
  });

  it("discards site state when account identity changes or disappears", () => {
    vi.stubEnv("VITE_SITE_HUD_DEMO_ENABLED", "true");
    const { rerender } = render(shell("first-account"));
    fireEvent.click(screen.getByRole("button", { name: "Open demo site" }));
    rerender(shell("second-account"));
    expect(
      screen.queryByRole("button", { name: "Close demo site" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open demo site" }));
    rerender(shell());
    expect(
      screen.queryByRole("button", { name: "Close demo site" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Open demo site" })).toBeNull();
  });
});
