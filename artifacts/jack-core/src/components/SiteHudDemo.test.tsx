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
import { Dashboard } from "./Dashboard";
import { SiteHudDemo } from "./SiteHudDemo";
import type { GraphModel } from "../lib/memory-graph";
import { collectJackUiContext } from "../lib/jack-ui-context";

vi.mock("./SystemHealthWidget", () => ({ SystemHealthWidget: () => null }));
const model: GraphModel = {
  topics: [],
  nodes: [],
  edges: [],
  degree: {},
  counts: { nodes: 0, connections: 0, knowledge: 0, topics: 0, videos: 0 },
};

function shell(
  userId?: string,
  active: JackView = "graph",
  onNavigate = vi.fn(),
) {
  return (
    <JackShell
      active={active}
      onNavigate={onNavigate}
      onOpenChat={vi.fn()}
      model={model}
      readyCount={0}
      lastUpdatedLabel="now"
      siteHudUserId={userId}
    >
      {active === "dashboard" ? (
        <Dashboard
          model={model}
          readyCount={0}
          lastUpdatedLabel="now"
          siteHudUserId={userId}
        />
      ) : (
        <div>{active} content</div>
      )}
    </JackShell>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("site radar release gate", () => {
  it("routes the signed-in HUD entry into Dashboard regardless of demo flag", () => {
    vi.stubEnv("VITE_SITE_HUD_DEMO_ENABLED", "true");
    const onNavigate = vi.fn();
    const { rerender } = render(shell("account-a", "graph", onNavigate));
    expect(screen.getByRole("button", { name: "Open radar" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open demo site" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open radar" }));
    expect(onNavigate).toHaveBeenCalledWith("dashboard");

    rerender(shell("account-a", "dashboard", onNavigate));
    expect(collectJackUiContext().surface).toBe("Dashboard");
    expect(screen.queryByRole("button", { name: "Open radar" })).toBeNull();
    expect(screen.getByRole("region", { name: "Jack dashboard" })).toBeTruthy();
  });

  it("hides radar without an account and clears location on account change", () => {
    const getCurrentPosition = vi.fn();
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("navigator", { geolocation: { getCurrentPosition } });
    const { rerender } = render(shell("account-a", "dashboard"));
    fireEvent.click(screen.getByRole("button", { name: "Use my location" }));
    act(() =>
      getCurrentPosition.mock.calls[0][0]({
        coords: { latitude: 1, longitude: 2, accuracy: 5 },
      }),
    );
    expect(screen.getByText(/1\.000000, 2\.000000/)).toBeTruthy();
    rerender(shell("account-b", "dashboard"));
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
