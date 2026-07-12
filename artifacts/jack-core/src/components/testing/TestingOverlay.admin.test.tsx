// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { TestingOverlay } from "./TestingOverlay";

const identity = vi.hoisted(() => ({ isAdmin: false }));

vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({ data: { email: "owner@torchlabs.ca", isAdmin: identity.isAdmin } }),
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("./UserTestingModal", () => ({
  UserTestingModal: ({ open }: { open: boolean }) => open ? <div data-testid="testing-consent" /> : null,
}));
vi.mock("./RecordingIndicator", () => ({ RecordingIndicator: () => null }));
vi.mock("./ThinkAloudBanner", () => ({ ThinkAloudBanner: () => null }));

describe("TestingOverlay admin bypass", () => {
  afterEach(cleanup);
  beforeEach(() => {
    sessionStorage.clear();
    window.history.replaceState({}, "", "/app");
    identity.isAdmin = false;
  });

  it("auto-prompts a regular authenticated user", async () => {
    render(<TestingOverlay autoPrompt />);
    expect(await screen.findByTestId("testing-consent")).toBeTruthy();
  });

  it("never auto-prompts a server-recognized administrator", async () => {
    identity.isAdmin = true;
    render(<TestingOverlay autoPrompt />);
    await waitFor(() => expect(screen.queryByTestId("testing-consent")).toBeNull());
  });
});
