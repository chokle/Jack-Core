// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { SiteHudLive } from "./SiteHudLive";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("live site radar", () => {
  it("starts empty without requesting location or showing fictional contacts", () => {
    const getCurrentPosition = vi.fn();
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("navigator", { geolocation: { getCurrentPosition } });
    render(<SiteHudLive expanded onOpenRadar={vi.fn()} />);
    expect(screen.getByText(/No site connected\. Site scans/)).toBeTruthy();
    expect(screen.getByText("Location off")).toBeTruthy();
    expect(screen.queryByTestId("radar-sweep")).toBeNull();
    expect(screen.queryByText("● Crew")).toBeNull();
    expect(getCurrentPosition).not.toHaveBeenCalled();
  });

  it("requests own position only on action and handles success and retryable error", () => {
    const getCurrentPosition = vi.fn();
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("navigator", { geolocation: { getCurrentPosition } });
    render(<SiteHudLive expanded onOpenRadar={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Use my location" }));
    expect(screen.getByText("Finding your location…")).toBeTruthy();
    expect(getCurrentPosition).toHaveBeenCalledOnce();
    act(() => getCurrentPosition.mock.calls[0][1]({ code: 1 }));
    expect(screen.getByRole("alert").textContent).toContain(
      "permission was denied",
    );
    fireEvent.click(screen.getByRole("button", { name: "Use my location" }));
    act(() =>
      getCurrentPosition.mock.calls[1][0]({
        coords: { latitude: 49.2827, longitude: -123.1207, accuracy: 12 },
      }),
    );
    expect(
      screen.getByText(/49\.282700, -123\.120700 · accuracy ±12 m/),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /geographic map/ }).getAttribute("href"),
    ).toContain("openstreetmap.org");
  });
});
