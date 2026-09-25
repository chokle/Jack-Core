// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { JackShell, type JackView } from "./JackShell";
import { SiteHudDemo } from "./SiteHudDemo";
import type { GraphModel } from "../lib/memory-graph";
import { collectJackUiContext } from "../lib/jack-ui-context";

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
  vi.unstubAllGlobals();
});

describe("site radar release gate", () => {
  it("exposes the empty live radar to a resolved account regardless of demo flag", () => {
    vi.stubEnv("VITE_SITE_HUD_DEMO_ENABLED", "true");
    const { rerender } = render(shell("account-a"));
    expect(screen.getByRole("button", { name: "Open radar" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open demo site" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open radar" }));
    rerender(shell("account-a", "radar"));
    expect(collectJackUiContext().surface).toBe("Site radar");
    expect(screen.getByText(/No site connected\. Site scans/)).toBeTruthy();
    expect(screen.queryByText("radar content")).toBeNull();
  });

  it("hides radar without an account and clears location on account change", () => {
    const getCurrentPosition = vi.fn();
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("navigator", { geolocation: { getCurrentPosition } });
    const { rerender } = render(shell("account-a", "radar"));
    fireEvent.click(screen.getByRole("button", { name: "Use my location" }));
    act(() =>
      getCurrentPosition.mock.calls[0][0]({
        coords: { latitude: 1, longitude: 2, accuracy: 5 },
      }),
    );
    expect(screen.getByText(/1\.000000, 2\.000000/)).toBeTruthy();
    rerender(shell("account-b", "radar"));
    expect(screen.getByText("Location off")).toBeTruthy();
    rerender(shell(undefined, "graph"));
    expect(screen.queryByRole("button", { name: "Open radar" })).toBeNull();
  });

  it("keeps the original fictional demo component opt-in and separate", () => {
    render(<SiteHudDemo onOpenRadar={vi.fn()} onExitRadar={vi.fn()} />);
    expect(screen.getByText("Fictional site · Demo only")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open demo site" }));
    expect(screen.getByText(/Fictional positions/)).toBeTruthy();
  });
});
