// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { SiteHudLive } from "./SiteHudLive";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

  it("requests AR only on action and reports unavailable devices", async () => {
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("navigator", {});
    render(<SiteHudLive expanded onOpenRadar={vi.fn()} />);
    expect(screen.getByText("Scan off")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start AR scan" }));
    expect(await screen.findByText(/AR depth is unavailable/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop AR scan" })).toBeNull();
  });

  it("does not request an immersive session on an unsupported desktop", async () => {
    const isSessionSupported = vi.fn().mockResolvedValue(false);
    const requestSession = vi.fn();
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("navigator", { xr: { isSessionSupported, requestSession } });
    render(<SiteHudLive expanded onOpenRadar={vi.fn()} />);
    expect(isSessionSupported).toHaveBeenCalledWith("immersive-ar");
    expect(screen.getByText("Checking AR support…")).toBeTruthy();
    const start = screen.getByRole("button", { name: "Start AR scan" });
    expect((start as HTMLButtonElement).disabled).toBe(true);
    await screen.findByText(
      "AR depth is unavailable on this device and browser.",
    );
    expect((start as HTMLButtonElement).disabled).toBe(true);
    expect(requestSession).not.toHaveBeenCalled();
  });

  it("tracks a measured AR surface, shows turns, and holds it on stop", async () => {
    const getDepthInMeters = vi.fn(() => 2);
    const frames: Array<(time: number, frame: unknown) => void> = [];
    const listeners = new Map<string, () => void>();
    const session = {
      updateRenderState: vi.fn(),
      requestReferenceSpace: vi.fn().mockResolvedValue({}),
      requestAnimationFrame: vi.fn(
        (callback: (time: number, frame: unknown) => void) =>
          frames.push(callback),
      ),
      addEventListener: vi.fn((name: string, callback: () => void) =>
        listeners.set(name, callback),
      ),
      removeEventListener: vi.fn(),
      end: vi.fn(async () => listeners.get("end")?.()),
    };
    const requestSession = vi.fn().mockResolvedValue(session);
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("navigator", { xr: { requestSession } });
    vi.stubGlobal(
      "XRWebGLLayer",
      class {
        framebuffer = null;
      },
    );
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      makeXRCompatible: vi.fn().mockResolvedValue(undefined),
      bindFramebuffer: vi.fn(),
      clearColor: vi.fn(),
      clear: vi.fn(),
      FRAMEBUFFER: 1,
      COLOR_BUFFER_BIT: 2,
    } as unknown as WebGLRenderingContext);
    render(<SiteHudLive expanded onOpenRadar={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Start AR scan" }));
    // Immersive WebXR must be requested in the same user-activation task.
    expect(requestSession).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(session.updateRenderState).toHaveBeenCalledOnce(),
    );
    expect(session.requestReferenceSpace).toHaveBeenCalledOnce();
    await waitFor(() => expect(frames.length).toBe(1));
    expect(screen.getByText("Waiting for AR tracking…")).toBeTruthy();
    expect(requestSession).toHaveBeenCalledWith(
      "immersive-ar",
      expect.objectContaining({
        requiredFeatures: ["local", "dom-overlay", "depth-sensing"],
        depthSensing: {
          usagePreference: ["cpu-optimized"],
          dataFormatPreference: ["luminance-alpha", "float32"],
        },
      }),
    );
    act(() =>
      frames.shift()?.(300, {
        getViewerPose: () => ({
          views: [
            {
              projectionMatrix: [1, 0, 0, 0, 0, 1],
              transform: {
                position: { x: 0, y: 0, z: 0 },
                orientation: { x: 0, y: 0, z: 0, w: 1 },
              },
            },
          ],
        }),
        getDepthInformation: () => null,
      }),
    );
    expect(
      screen.getByText(/Tracking active · waiting for depth/),
    ).toBeTruthy();
    expect(screen.queryAllByLabelText(/Measured surface/)).toHaveLength(0);
    act(() =>
      frames.shift()?.(600, {
        getViewerPose: () => ({
          views: [
            {
              projectionMatrix: [1, 0, 0, 0, 0, 1],
              transform: {
                position: { x: 0, y: 0, z: 0 },
                orientation: { x: 0, y: 0, z: 0, w: 1 },
              },
            },
          ],
        }),
        getDepthInformation: () => ({ getDepthInMeters }),
      }),
    );
    expect(getDepthInMeters).toHaveBeenCalledWith(0.2, 0.3);
    expect(getDepthInMeters).toHaveBeenCalledWith(0.8, 0.7);
    expect(screen.getByRole("button", { name: "Stop AR scan" })).toBeTruthy();
    expect(screen.getByText(/measured surfaces · turn the phone/)).toBeTruthy();
    expect(screen.getAllByLabelText(/Measured surface/).length).toBeGreaterThan(
      0,
    );
    act(() =>
      frames.shift()?.(900, {
        getViewerPose: () => ({
          views: [
            {
              projectionMatrix: [1, 0, 0, 0, 0, 1],
              transform: {
                position: { x: 0, y: 0, z: 0 },
                orientation: { x: 0, y: -Math.SQRT1_2, z: 0, w: Math.SQRT1_2 },
              },
            },
          ],
        }),
        getDepthInformation: () => ({ getDepthInMeters: () => 2 }),
      }),
    );
    expect(screen.getByText("090°")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop AR scan" }));
    expect(session.end).toHaveBeenCalledOnce();
    expect(
      screen.getByText(/Scan stopped · .* measured surfaces/),
    ).toBeTruthy();
    const download = screen.getByRole("button", {
      name: /Download depth points/,
    });
    expect((download as HTMLButtonElement).disabled).toBe(false);
    const NativeURL = URL;
    class DownloadURL extends NativeURL {
      static createObjectURL = vi.fn(() => "blob:local-depth");
      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal("URL", DownloadURL);
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    fireEvent.click(download);
    expect(DownloadURL.createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(screen.getAllByLabelText(/Measured surface/).length).toBeGreaterThan(
      0,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show 50 m view" }));
    expect(screen.getByText(/50 M VIEW/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear scan" }));
    expect(screen.getByText("Scan off")).toBeTruthy();
    expect(screen.queryAllByLabelText(/Measured surface/)).toHaveLength(0);
  });
});
