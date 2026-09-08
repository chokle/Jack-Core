// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render as renderComponent,
  screen,
} from "@testing-library/react";
import { SiteRadar } from "./SiteRadar";
import type { ReactElement } from "react";
import type { HudLandmark } from "../lib/site-hud";
import {
  compassHeading,
  contactIllumination,
  radarBearing,
} from "../lib/radar-heading";

function render(ui: ReactElement) {
  const result = renderComponent(ui);
  fireEvent.click(screen.getByRole("button", { name: "Compass controls" }));
  return result;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("radar compass", () => {
  it.each(["future-station", "constructor"])(
    "keeps an unfamiliar safety landmark %s visible without crashing the radar",
    (kind) => {
      render(
        <SiteRadar
          crew={[]}
          floorLabel="Ground"
          landmarks={[
            {
              id: "future",
              label: "Future safety station",
              kind: kind as HudLandmark["kind"],
              floorId: "ground",
              x: 25,
              y: 25,
            },
          ]}
        />,
      );
      expect(
        screen.getByRole("img", {
          name: `Future safety station, ${kind}, 35 meters away`,
        }),
      ).toBeTruthy();
      expect(screen.getByTestId("radar-world")).toBeTruthy();
    },
  );
  it("takes four seconds to complete a sweep", () => {
    let frame: FrameRequestCallback = () => {};
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    render(<SiteRadar crew={[]} landmarks={[]} floorLabel="Ground" />);
    act(() => frame(1000));
    expect(screen.getByTestId("radar-sweep").getAttribute("transform")).toBe(
      "rotate(90 200 200)",
    );
    act(() => frame(2000));
    expect(screen.getByTestId("radar-sweep").getAttribute("transform")).toBe(
      "rotate(180 200 200)",
    );
    act(() => frame(4000));
    expect(screen.getByTestId("radar-sweep").getAttribute("transform")).toBe(
      "rotate(0 200 200)",
    );
  });

  it("keeps north world anchored as the viewer turns", () => {
    render(<SiteRadar crew={[]} landmarks={[]} floorLabel="Ground" />);
    fireEvent.change(
      screen.getByRole("slider", { name: /Turn demo heading/ }),
      { target: { value: "90" } },
    );
    expect(screen.getByTestId("radar-world").getAttribute("transform")).toBe(
      "rotate(-90 200 200)",
    );
    expect(screen.getByText("N").getAttribute("transform")).toBe(
      "rotate(90 200 20)",
    );
    expect(screen.getByText(/sweep is a visual simulation/)).toBeTruthy();
  });

  it("pings at the same angular position as the clockwise sweep", () => {
    expect(radarBearing(50, 0)).toBe(0);
    expect(radarBearing(100, 50)).toBe(90);
    expect(contactIllumination(90, 0, 90)).toBe(1);
    expect(contactIllumination(90, 90, 0)).toBe(1);
    expect(contactIllumination(90, 0, 89)).toBe(0.3);
  });

  it("reports distance from the viewer in meters", () => {
    render(
      <SiteRadar
        crew={[]}
        floorLabel="Ground"
        landmarks={[{
          id: "east",
          label: "East beacon",
          kind: "air-horn",
          floorId: "ground",
          x: 60,
          y: 50,
        }]}
      />,
    );
    expect(screen.getByRole("img", { name: /East beacon.*10 meters away/ })).toBeTruthy();
  });

  it("rejects relative, invalid, inaccurate and tilted compass readings", () => {
    const flat = { alpha: 270, beta: 0, gamma: 0, absolute: true };
    expect(compassHeading(flat)).toBe(90);
    expect(compassHeading(flat, 90)).toBe(180);
    expect(compassHeading({ ...flat, absolute: false })).toBeNull();
    expect(compassHeading({ ...flat, alpha: NaN })).toBeNull();
    expect(compassHeading({ ...flat, beta: 60 })).toBeNull();
    expect(
      compassHeading({
        ...flat,
        absolute: false,
        webkitCompassHeading: 120,
        webkitCompassAccuracy: -1,
      }),
    ).toBeNull();
    expect(
      compassHeading({
        ...flat,
        absolute: false,
        webkitCompassHeading: 120,
        webkitCompassAccuracy: 10,
      }),
    ).toBe(120);
  });

  it("does not attach compass listeners without an explicit permitted action", async () => {
    vi.stubGlobal("isSecureContext", true);
    const requestPermission = vi.fn().mockResolvedValue("denied");
    vi.stubGlobal("DeviceOrientationEvent", { requestPermission });
    const listen = vi.spyOn(window, "addEventListener");
    render(<SiteRadar crew={[]} landmarks={[]} floorLabel="Ground" />);
    expect(
      listen.mock.calls.some(([name]) => name === "deviceorientation"),
    ).toBe(false);
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: "Use device compass" }),
      ),
    );
    expect(requestPermission).toHaveBeenCalledWith(true);
    expect(screen.getByText(/Compass permission denied/)).toBeTruthy();
    expect(
      listen.mock.calls.some(([name]) => name === "deviceorientation"),
    ).toBe(false);
  });

  it("expires stale sensor data and removes listeners when the radar becomes inactive", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("DeviceOrientationEvent", {
      requestPermission: vi.fn().mockResolvedValue("granted"),
    });
    const remove = vi.spyOn(window, "removeEventListener");
    const { rerender } = render(
      <SiteRadar crew={[]} landmarks={[]} floorLabel="Ground" />,
    );
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: "Use device compass" }),
      ),
    );
    const event = new Event("deviceorientationabsolute");
    Object.assign(event, { alpha: 270, beta: 0, gamma: 0, absolute: true });
    act(() => window.dispatchEvent(event));
    expect(screen.getByTestId("radar-world").getAttribute("transform")).toBe(
      "rotate(-90 200 200)",
    );
    act(() => vi.advanceTimersByTime(3001));
    expect(screen.getByText(/Compass unavailable or stale/)).toBeTruthy();
    expect(screen.getByTestId("radar-world").getAttribute("transform")).toBe(
      "rotate(0 200 200)",
    );
    rerender(
      <SiteRadar crew={[]} landmarks={[]} floorLabel="Ground" active={false} />,
    );
    expect(
      remove.mock.calls.some(([name]) => name === "deviceorientationabsolute"),
    ).toBe(true);
  });

  it("does not resume a pending permission request after leaving the page", async () => {
    vi.stubGlobal("isSecureContext", true);
    let resolve!: (value: string) => void;
    vi.stubGlobal("DeviceOrientationEvent", {
      requestPermission: () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    });
    const { rerender } = render(
      <SiteRadar crew={[]} landmarks={[]} floorLabel="Ground" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Use device compass" }));
    rerender(
      <SiteRadar crew={[]} landmarks={[]} floorLabel="Ground" active={false} />,
    );
    await act(async () => resolve("granted"));
    expect(
      screen.getByRole("button", { name: "Use device compass" }),
    ).toBeTruthy();
    expect(screen.getByText("Manual demo heading")).toBeTruthy();
  });

  it("omits the moving sweep for reduced motion", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    );
    render(<SiteRadar crew={[]} landmarks={[]} floorLabel="Ground" />);
    expect(screen.queryByTestId("radar-sweep")).toBeNull();
  });
});
