// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { createSiteHudFixture } from "../lib/site-hud";
import { SiteHud } from "./SiteHud";

const NOW = Date.parse("2026-09-05T12:00:00Z");
let online: ReturnType<typeof vi.spyOn>;
const openPanel = (name: string) =>
  fireEvent.click(screen.getByRole("button", { name }));
const mode = () => screen.getByRole("status").textContent;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Site HUD demo", () => {
  it("starts collapsed with explicit simulation and navigation limits", () => {
    render(<SiteHud {...createSiteHudFixture(NOW)} />);

    expect(mode()).toBe("ONLINE");
    expect(screen.getByText("SIMULATION")).toBeTruthy();
    expect(
      screen.getByText("Simulated data · Not for navigation"),
    ).toBeTruthy();
    expect(screen.queryByRole("heading")).toBeNull();
    for (const button of screen.getAllByRole("button"))
      expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(
      screen.getByRole("group", { name: /Schematic radar: Ground/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole("img", {
        name: /Avery Chen; LIVE; Cloud sample; 11:59:58 UTC; 2s old/,
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("img", {
        name: /Jordan Ellis; DIRECT; Direct local sample/,
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("img", { name: /Casey Brooks/ })).toBeNull();
  });

  it("opens accessible panels, changes floors, and restores focus with Escape", () => {
    render(<SiteHud {...createSiteHudFixture(NOW)} />);
    const floorButton = screen.getByRole("button", {
      name: "Floor / elevation",
    });
    fireEvent.click(floorButton);
    const panel = screen.getByRole("region", { name: "Floor / elevation" });
    expect(document.activeElement).toBe(panel);
    expect(floorButton.getAttribute("aria-controls")).toBe(panel.id);

    fireEvent.click(screen.getByRole("button", { name: /Level 1 4 m/ }));
    expect(
      screen.getByRole("group", { name: /Schematic radar: Level 1/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole("img", {
        name: /Sam Morgan; RELAYED; Relayed local sample/,
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("img", { name: /Avery Chen/ })).toBeNull();

    fireEvent.keyDown(panel, { key: "Escape" });
    expect(
      screen.queryByRole("region", { name: "Floor / elevation" }),
    ).toBeNull();
    expect(document.activeElement).toBe(floorButton);
    expect(floorButton.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps private identities and positions out of every panel and radar floor", () => {
    const { container } = render(<SiteHud {...createSiteHudFixture(NOW)} />);
    openPanel("Crew roster");
    const crew = screen.getByRole("region", { name: "Crew roster" });
    expect(within(crew).getByText(/Other nearby:/).textContent).toContain("2");
    expect(within(crew).getByText("Avery Chen")).toBeTruthy();
    expect(
      within(crew).getByLabelText("Position confidence legend").textContent,
    ).toContain("SIGNAL LOST");

    for (const panel of [
      "Floor / elevation",
      "Safety landmarks",
      "Site alerts",
      "Signal / simulation",
    ]) {
      openPanel(panel);
      expect(container.innerHTML).not.toContain("Outside Private");
      expect(container.innerHTML).not.toContain("outside-private");
      expect(container.innerHTML).not.toContain("Private trade");
    }
    openPanel("Floor / elevation");
    for (const label of [/Level 1 4 m/, /Level 2 8 m/]) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      expect(container.innerHTML).not.toContain("translate(84,59)");
      expect(container.innerHTML).not.toContain("translate(81,56)");
      expect(screen.queryByRole("img", { name: /Outside Private/ })).toBeNull();
    }
  });

  it("requires explicit demo reconciliation before restoring ONLINE", () => {
    render(<SiteHud {...createSiteHudFixture(NOW)} />);
    openPanel("Signal / simulation");
    fireEvent.click(
      screen.getByRole("button", { name: "Simulate reception loss" }),
    );
    expect(mode()).toBe("OTG");
    expect(
      screen
        .getByRole("region", { name: "Site HUD simulation" })
        .getAttribute("data-mode"),
    ).toBe("OTG");
    expect(
      screen.getByRole("img", { name: /Avery Chen; LAST KNOWN/ }),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Record demo check-in" }),
    );
    expect(screen.getByText(/Demo queue:/).textContent).toContain("1 pending");
    fireEvent.click(screen.getByRole("button", { name: "Simulate reconnect" }));
    expect(mode()).toBe("OTG SYNCING");
    act(() => vi.advanceTimersByTime(5_000));
    expect(mode()).toBe("OTG SYNCING");
    expect(
      screen.getByText(/Awaiting explicit demo reconciliation/),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Reconcile demo queue" }),
    );
    expect(mode()).toBe("ONLINE");
    expect(screen.getByText(/Demo queue:/).textContent).toContain("0 pending");
    expect(screen.getByText(/Reconciliation transmits nothing/)).toBeTruthy();
  });

  it("keeps Escape local after a focused simulation control becomes disabled", () => {
    render(<SiteHud {...createSiteHudFixture(NOW)} />);
    openPanel("Signal / simulation");
    const loss = screen.getByRole("button", {
      name: "Simulate reception loss",
    });
    loss.focus();
    fireEvent.click(loss);
    const panel = screen.getByRole("region", { name: "Signal / simulation" });
    expect(document.activeElement).toBe(panel);
    const appEscape = vi.fn();
    window.addEventListener("keydown", appEscape);
    try {
      fireEvent.keyDown(panel, { key: "Escape" });
      expect(appEscape).not.toHaveBeenCalled();
      expect(
        screen.queryByRole("region", { name: "Signal / simulation" }),
      ).toBeNull();
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Signal / simulation" }),
      );
      openPanel("Signal / simulation");
      fireEvent.keyDown(window, { key: "Escape" });
      expect(appEscape).toHaveBeenCalledOnce();
      expect(
        screen.getByRole("region", { name: "Signal / simulation" }),
      ).toBeTruthy();
    } finally {
      window.removeEventListener("keydown", appEscape);
    }
  });

  it("honors browser offline state and reconnect loss during reconciliation", () => {
    online.mockReturnValue(false);
    render(<SiteHud {...createSiteHudFixture(NOW)} />);
    openPanel("Signal / simulation");
    expect(mode()).toBe("OTG");
    const reconnect = screen.getByRole("button", {
      name: "Simulate reconnect",
    }) as HTMLButtonElement;
    expect(reconnect.disabled).toBe(true);
    fireEvent.click(reconnect);
    expect(mode()).toBe("OTG");

    online.mockReturnValue(true);
    act(() => window.dispatchEvent(new Event("online")));
    expect(mode()).toBe("OTG SYNCING");
    online.mockReturnValue(false);
    act(() => window.dispatchEvent(new Event("offline")));
    expect(mode()).toBe("OTG");
    expect(
      (
        screen.getByRole("button", {
          name: "Reconcile demo queue",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    online.mockReturnValue(true);
    act(() => window.dispatchEvent(new Event("online")));
    fireEvent.click(
      screen.getByRole("button", { name: "Reconcile demo queue" }),
    );
    expect(mode()).toBe("ONLINE");
  });

  it("retains events recorded during a demo reconciliation until the next explicit pass", () => {
    render(<SiteHud {...createSiteHudFixture(NOW)} />);
    openPanel("Signal / simulation");
    fireEvent.click(
      screen.getByRole("button", { name: "Simulate reception loss" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Record demo check-in" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Simulate reconnect" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Record demo check-in" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Reconcile demo queue" }),
    );
    expect(mode()).toBe("OTG SYNCING");
    expect(screen.getByText(/Demo queue:/).textContent).toContain("1 pending");
    fireEvent.click(
      screen.getByRole("button", { name: "Reconcile demo queue" }),
    );
    expect(mode()).toBe("ONLINE");
  });

  it("ages samples through last known to signal lost without inventing fresh positions", () => {
    const fixture = createSiteHudFixture(NOW);
    render(<SiteHud {...fixture} />);
    act(() => vi.advanceTimersByTime(15_000));
    expect(
      screen.getByRole("img", {
        name: /Avery Chen; LAST KNOWN; Cloud sample; 11:59:58 UTC; 17s old/,
      }),
    ).toBeTruthy();
    act(() => vi.advanceTimersByTime(120_000));
    expect(screen.queryByRole("img", { name: /Avery Chen/ })).toBeNull();
    openPanel("Crew roster");
    const avery = screen.getByText("Avery Chen").closest("li")!;
    expect(within(avery).getByText("SIGNAL LOST")).toBeTruthy();
    expect(avery.textContent).toContain("Position unavailable");
    expect(avery.textContent).toContain("11:59:58 UTC");
  });

  it("removes browser listeners and the aging timer on unmount", () => {
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(<SiteHud {...createSiteHudFixture(NOW)} />);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    for (const event of ["online", "offline"]) {
      const listener = added.mock.calls.find((call) => call[0] === event)?.[1];
      expect(listener).toBeTruthy();
      expect(removed).toHaveBeenCalledWith(event, listener);
    }
  });
});
