// @vitest-environment jsdom
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { TestingOverlay, type TestingOverlayHandle } from "./TestingOverlay";

const state = vi.hoisted(() => ({ session: null as null | Record<string, unknown> }));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/user-testing/test-session-service", () => ({
  getCachedTestSession: () => state.session,
  trackTestEvent: vi.fn(),
}));
vi.mock("./UserTestingModal", () => ({
  UserTestingModal: ({ open }: { open: boolean }) => open ? <div data-testid="testing-consent" /> : null,
}));
vi.mock("./RecordingIndicator", () => ({ RecordingIndicator: () => null }));
vi.mock("./ThinkAloudBanner", () => ({ ThinkAloudBanner: () => null }));

describe("TestingOverlay consent boundary", () => {
  afterEach(cleanup);
  beforeEach(() => {
    sessionStorage.clear();
    window.history.replaceState({}, "", "/app");
    state.session = null;
  });

  it("never auto-prompts", () => {
    render(<TestingOverlay />);
    expect(screen.queryByTestId("testing-consent")).toBeNull();
  });

  it("opens only for an active session with screen consent", () => {
    state.session = {
      id: "11111111-1111-4111-8111-111111111111",
      screenConsentState: "granted",
    };
    const ref = createRef<TestingOverlayHandle>();
    render(<TestingOverlay ref={ref} />);
    act(() => ref.current?.open());
    expect(screen.getByTestId("testing-consent")).toBeTruthy();
  });
});
