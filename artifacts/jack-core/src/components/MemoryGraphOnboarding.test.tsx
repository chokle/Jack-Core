// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MemoryGraphOnboarding,
  useMemoryGraphOnboarding,
} from "./MemoryGraphOnboarding";

const apiState = vi.hoisted(() => ({
  preference: null as null | { version: 1; status: "completed" | "skipped" },
  isSuccess: true,
  isError: false,
  mutate: vi.fn(),
  track: vi.fn(),
}));

vi.mock("@workspace/api-client-react", () => ({
  getGetMemoryGraphOnboardingPreferenceQueryKey: () => [
    "/api/me/preferences/memory-graph-onboarding",
  ],
  useGetMemoryGraphOnboardingPreference: () => ({
    data: { preference: apiState.preference },
    isSuccess: apiState.isSuccess,
    isError: apiState.isError,
  }),
  useUpdateMemoryGraphOnboardingPreference: () => ({ mutate: apiState.mutate }),
  trackMemoryGraphOnboardingEvent: (...args: unknown[]) =>
    apiState.track(...args),
}));
vi.mock("@/lib/user-testing/test-session-service", () => ({
  getCachedTestSession: () => null,
  trackTestEvent: vi.fn(),
}));

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}

function Harness() {
  const stageRef = useRef<HTMLDivElement>(null);
  const connectionRef = useRef<HTMLDivElement>(null);
  const growthRef = useRef<HTMLDivElement>(null);
  const controller = useMemoryGraphOnboarding();

  return (
    <div ref={stageRef} className="relative">
      <button type="button" onClick={controller.reopen}>
        How this works
      </button>
      <div ref={connectionRef}>Connections</div>
      <div ref={growthRef}>Growth</div>
      <MemoryGraphOnboarding
        controller={controller}
        stageRef={stageRef}
        connectionTargetRef={connectionRef}
        growthTargetRef={growthRef}
        reducedMotion={false}
      />
    </div>
  );
}

function renderHarness() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <Harness />
    </QueryClientProvider>,
  );
}

describe("MemoryGraphOnboarding", () => {
  beforeEach(() => {
    apiState.preference = null;
    apiState.isSuccess = true;
    apiState.isError = false;
    apiState.mutate.mockReset();
    apiState.track.mockReset().mockResolvedValue({ accepted: true });
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("opens once for a first eligible visit without using the legacy analytics channel", async () => {
    const view = renderHarness();

    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Step 1 of 3")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Jack’s Living Memory" }),
    ).toBeTruthy();

    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <Harness />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(apiState.track).not.toHaveBeenCalled());
  });

  it.each(["completed", "skipped"] as const)(
    "does not automatically reopen a %s preference",
    async (status) => {
      apiState.preference = { version: 1, status };
      renderHarness();

      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(apiState.track).not.toHaveBeenCalled();
    },
  );

  it("persists skip and closes immediately", async () => {
    renderHarness();
    await screen.findByRole("dialog");

    fireEvent.click(screen.getByRole("button", { name: "Skip" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(apiState.mutate).toHaveBeenCalledWith({
      data: { version: 1, status: "skipped" },
    });
    expect(apiState.track).not.toHaveBeenCalled();
  });

  it("completes all three steps and persists completion", async () => {
    renderHarness();
    await screen.findByRole("dialog");

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Step 2 of 3")).toBeTruthy();
    expect(
      screen.getByText(
        "Tap a node for details. Drag to explore and pinch or scroll to zoom.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Step 3 of 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(apiState.mutate).toHaveBeenCalledWith({
      data: { version: 1, status: "completed" },
    });
    expect(apiState.track).not.toHaveBeenCalled();
  });

  it("replays without overwriting an existing completed or skipped preference", async () => {
    apiState.preference = { version: 1, status: "skipped" };
    renderHarness();
    fireEvent.click(screen.getByRole("button", { name: "How this works" }));

    expect(await screen.findByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));

    expect(apiState.track).not.toHaveBeenCalled();
    expect(apiState.mutate).not.toHaveBeenCalled();
  });

  it("fails open on preference read and write failures", async () => {
    apiState.isSuccess = false;
    apiState.isError = true;
    apiState.mutate.mockImplementation(() => undefined);
    renderHarness();

    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "How this works" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "How this works" })).toBeTruthy();
  });

  it("supports arrow navigation and Escape without marking the walkthrough seen", async () => {
    renderHarness();
    const dialog = await screen.findByRole("dialog");

    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(screen.getByText("Step 2 of 3")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowLeft" });
    expect(screen.getByText("Step 1 of 3")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(apiState.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "How this works" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("moves focus to the primary action and exposes the non-modal dialog contract", async () => {
    renderHarness();
    const dialog = await screen.findByRole("dialog");

    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Next" }),
      ),
    );
    expect(dialog.getAttribute("aria-modal")).toBe("false");
    expect(
      (screen.getByRole("button", { name: "Back" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
