// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, renderHook, cleanup } from "@testing-library/react";
import type { SystemHealthSnapshot } from "@workspace/api-client-react";

/**
 * Regression coverage for the single most important correctness property of the
 * heartbeat widget: it must NEVER read "Healthy" while the backend is
 * unreachable. `useSystemHealth` flips to `isOffline` after two consecutive
 * failed polls, and the widget must then render the "Offline" label with no live
 * BPM. A successful poll, by contrast, must report the server's status/BPM/color.
 *
 * The generated `useGetSystemHealth` query is mocked so we can drive `data` /
 * `isLoading` / `failureCount` directly without any network.
 */

// Controllable query result, hoisted so the vi.mock factory can close over it.
const h = vi.hoisted(() => ({
  query: {
    data: undefined as SystemHealthSnapshot | undefined,
    isLoading: false,
    failureCount: 0,
  },
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetSystemHealth: () => h.query,
  getGetSystemHealthQueryKey: () => ["system-health"],
}));

import { SystemHealthWidget } from "./SystemHealthWidget";
import { useSystemHealth } from "../hooks/use-system-health";

const HEALTHY: SystemHealthSnapshot = {
  vitalityScore: 92,
  heartbeatBPM: 84,
  pulseColor: "purple",
  status: "Reasoning",
  state: "reasoning",
};

function setQuery(next: Partial<typeof h.query>) {
  h.query = { ...h.query, ...next };
}

beforeEach(() => {
  h.query = { data: undefined, isLoading: false, failureCount: 0 };
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("useSystemHealth — offline threshold", () => {
  it("reports the server snapshot and stays online while polls succeed", () => {
    setQuery({ data: HEALTHY, isLoading: false, failureCount: 0 });
    const { result } = renderHook(() => useSystemHealth());
    expect(result.current.isOffline).toBe(false);
    expect(result.current.snapshot.status).toBe("Reasoning");
    expect(result.current.snapshot.heartbeatBPM).toBe(84);
  });

  it("rides out a single transient failure without going offline", () => {
    setQuery({ data: undefined, isLoading: false, failureCount: 1 });
    const { result } = renderHook(() => useSystemHealth());
    // One miss is not enough — still online (falls back to the resting default).
    expect(result.current.isOffline).toBe(false);
  });

  it("flips to offline once two consecutive polls fail", () => {
    setQuery({ data: undefined, isLoading: false, failureCount: 2 });
    const { result } = renderHook(() => useSystemHealth());
    expect(result.current.isOffline).toBe(true);
  });

  it("stays offline as failures continue to mount", () => {
    setQuery({ data: undefined, isLoading: false, failureCount: 7 });
    const { result } = renderHook(() => useSystemHealth());
    expect(result.current.isOffline).toBe(true);
  });
});

describe("SystemHealthWidget — never falsely healthy", () => {
  it("shows the reported status and BPM when a poll succeeds", () => {
    setQuery({ data: HEALTHY, isLoading: false, failureCount: 0 });
    render(<SystemHealthWidget />);

    // Reported status + BPM are shown; the offline label/flatline are not.
    expect(screen.getByText("Reasoning")).toBeTruthy();
    expect(screen.getByText("84")).toBeTruthy();
    expect(screen.queryByText("Offline")).toBeNull();
    expect(screen.queryByText("--")).toBeNull();

    const widget = screen.getByRole("img");
    expect(widget.getAttribute("aria-label")).toContain("Reasoning");
    expect(widget.getAttribute("aria-label")).toContain("84 beats per minute");
  });

  it("renders the Offline label and no live BPM after repeated failures", () => {
    setQuery({ data: undefined, isLoading: false, failureCount: 2 });
    render(<SystemHealthWidget />);

    // The widget must NOT read healthy — Offline label, flatline "--" BPM.
    expect(screen.getByText("Offline")).toBeTruthy();
    expect(screen.getByText("--")).toBeTruthy();
    expect(screen.queryByText("Healthy")).toBeNull();
    expect(screen.queryByText("84")).toBeNull();

    const widget = screen.getByRole("img");
    expect(widget.getAttribute("aria-label")).toContain("offline");
    expect(widget.getAttribute("aria-label")).toContain("backend unreachable");
  });

  it("does not show Offline after only one failed poll", () => {
    setQuery({ data: undefined, isLoading: false, failureCount: 1 });
    render(<SystemHealthWidget />);
    expect(screen.queryByText("Offline")).toBeNull();
  });
});
