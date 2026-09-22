// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DazRuntimeCheck } from "./DazRuntimeCheck";

const authenticatedFetch = vi.hoisted(() => vi.fn());
vi.mock("@workspace/api-client-react", () => ({ authenticatedFetch }));

const html = readFileSync(
  path.resolve(import.meta.dirname, "../../index.html"),
  "utf8",
);
const bootstrap = html.match(
  /<script>\s*([\s\S]*?__JACK_MARK_READY__[\s\S]*?)<\/script>/,
)?.[1];
if (!bootstrap) throw new Error("Production startup watchdog not found");

beforeEach(() => {
  vi.useFakeTimers();
  authenticatedFetch.mockReset();
  // Exercise the shipped watchdog, not a replacement timer invented by the test.
  window.eval(bootstrap);
});

afterEach(() => {
  cleanup();
  window.__JACK_MARK_READY__?.();
  delete window.__JACK_MARK_READY__;
  delete window.__JACK_REPAIR_SESSION__;
  vi.useRealTimers();
});

describe("Daz runtime page startup", () => {
  it("proves the production watchdog shows recovery for an unready page", () => {
    act(() => vi.advanceTimersByTime(13000));
    expect(document.getElementById("jack-startup-recovery")).not.toBeNull();
  });

  it("keeps a usable checking page visible after the startup deadline", async () => {
    authenticatedFetch.mockReturnValue(new Promise(() => {}));
    render(<DazRuntimeCheck />);
    await act(async () => vi.advanceTimersByTime(13000));
    expect(screen.getByText("Checking production runtime...")).toBeTruthy();
    expect(document.getElementById("jack-startup-recovery")).toBeNull();
  });

  it("shows an endpoint error and retry without demanding browser repair", async () => {
    authenticatedFetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({
        ok: false,
        error: "Daz runtime status unavailable.",
      }),
    });
    await act(async () => {
      render(<DazRuntimeCheck />);
    });
    await act(async () => vi.advanceTimersByTime(13000));
    expect(screen.getByText("Daz runtime status unavailable.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run check" })).toBeTruthy();
    expect(document.getElementById("jack-startup-recovery")).toBeNull();
  });
});
