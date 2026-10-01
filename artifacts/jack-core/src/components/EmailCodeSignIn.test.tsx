// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { EmailCodeSignIn } from "./EmailCodeSignIn";

const h = vi.hoisted(() => ({
  create: vi.fn(),
  prepare: vi.fn(),
  attempt: vi.fn(),
  setActive: vi.fn(),
  setLocation: vi.fn(),
  assign: vi.fn(),
  auth: { isLoaded: true, isSignedIn: false },
}));
vi.mock("@clerk/react", () => ({
  useAuth: () => h.auth,
  SignIn: () => (
    <div data-testid="clerk-security">Complete account security</div>
  ),
}));
vi.mock("@clerk/react/legacy", () => ({
  useSignIn: () => ({
    isLoaded: true,
    signIn: { create: h.create, attemptFirstFactor: h.attempt },
    setActive: h.setActive,
  }),
}));
vi.mock("wouter", () => ({ useLocation: () => ["/sign-in", h.setLocation] }));
const originalLocation = window.location;
function location(search = "") {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      search,
      href: `http://localhost/sign-in${search}`,
      assign: h.assign,
    },
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  h.auth.isLoaded = true;
  h.auth.isSignedIn = false;
  location();
  h.create.mockResolvedValue({
    supportedFirstFactors: [
      { strategy: "email_code", emailAddressId: "email-1" },
    ],
    prepareFirstFactor: h.prepare,
  });
  h.attempt.mockResolvedValue({
    status: "complete",
    createdSessionId: "session-1",
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: originalLocation,
  });
});
async function start() {
  fireEvent.change(screen.getByLabelText("Email address"), {
    target: { value: "ROB@example.test" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Send verification code" }),
  );
  await screen.findByLabelText("Verification code");
}
function verify() {
  fireEvent.change(screen.getByLabelText("Verification code"), {
    target: { value: "123456" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}
describe("email-code and invitation sign-in", () => {
  it("uses Clerk email verification for every user and enables mobile OTP autofill", async () => {
    render(<EmailCodeSignIn />);
    await start();
    expect(h.create).toHaveBeenCalledWith({ identifier: "rob@example.test" });
    expect(h.prepare).toHaveBeenCalledWith({
      strategy: "email_code",
      emailAddressId: "email-1",
    });
    expect(
      screen.getByLabelText("Verification code").getAttribute("autocomplete"),
    ).toBe("one-time-code");
    verify();
    await waitFor(() => expect(h.assign).toHaveBeenCalledWith("/app"));
    expect(h.attempt).toHaveBeenCalledWith({
      strategy: "email_code",
      code: "123456",
    });
    expect(h.setActive).toHaveBeenCalledWith({ session: "session-1" });
  });
  it.each(["needs_second_factor", "needs_client_trust", "needs_new_password"])(
    "continues %s using Clerk without activating an incomplete session",
    async (status) => {
      h.attempt.mockResolvedValue({ status, createdSessionId: null });
      render(<EmailCodeSignIn />);
      await start();
      verify();
      await screen.findByTestId("clerk-security");
      expect(h.setActive).not.toHaveBeenCalled();
      expect(h.assign).not.toHaveBeenCalled();
    },
  );
  it("leaves security-enabled existing accounts a supported fallback when email code is unavailable", async () => {
    h.create.mockResolvedValue({
      supportedFirstFactors: [{ strategy: "password" }],
    });
    render(<EmailCodeSignIn />);
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "member@example.test" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Send verification code" }),
    );
    await screen.findByTestId("clerk-security");
    expect(h.setActive).not.toHaveBeenCalled();
  });
  it.each(["", "&__clerk_status=sign_up", "&__clerk_status=sign_in"])(
    "takes an invited/preprovisioned user through email OTP regardless of ticket status %s",
    async (status) => {
      location(`?__clerk_ticket=invitation-token${status}`);
      render(<EmailCodeSignIn />);
      expect(
        screen.getByRole("heading", { name: "You're invited to Jack" }),
      ).toBeTruthy();
      expect(h.create).not.toHaveBeenCalled();
      expect(screen.queryByLabelText(/password/i)).toBeNull();
      await start();
      expect(h.create).toHaveBeenCalledExactlyOnceWith({
        identifier: "rob@example.test",
      });
      expect(h.prepare).toHaveBeenCalledExactlyOnceWith({
        strategy: "email_code",
        emailAddressId: "email-1",
      });
      verify();
      await waitFor(() => expect(h.assign).toHaveBeenCalledWith("/app"));
      expect(h.setActive).toHaveBeenCalledWith({ session: "session-1" });
    },
  );
  it("removes sensitive ticket/status parameters while preserving unrelated URL and history state", () => {
    location(
      "?view=interview&__clerk_ticket=secret&__clerk_status=sign_up#note",
    );
    const replace = vi.spyOn(window.history, "replaceState");
    const previousState = window.history.state;
    render(<EmailCodeSignIn />);
    expect(replace).toHaveBeenCalledWith(
      previousState,
      "",
      "/sign-in?view=interview#note",
    );
    expect(h.create).not.toHaveBeenCalled();
  });
  it("still permits email OTP if browser history replacement is unavailable", async () => {
    location("?__clerk_ticket=invite");
    vi.spyOn(window.history, "replaceState").mockImplementation(() => {
      throw new Error("restricted");
    });
    render(<EmailCodeSignIn />);
    await start();
    verify();
    await waitFor(() => expect(h.assign).toHaveBeenCalledWith("/app"));
  });
  it("uses OTP rather than trusting a stale invitation as membership authority", async () => {
    location("?__clerk_ticket=stale-or-revoked");
    render(<EmailCodeSignIn />);
    await start();
    verify();
    await waitFor(() =>
      expect(h.setActive).toHaveBeenCalledWith({ session: "session-1" }),
    );
    expect(h.create).toHaveBeenCalledExactlyOnceWith({
      identifier: "rob@example.test",
    });
    // JackAccess subsequently accepts or denies membership using the server response.
  });
  it.each(["create", "prepare", "attempt", "setActive"] as const)(
    "contains %s failures without redirecting",
    async (operation) => {
      h[operation].mockRejectedValueOnce(new Error("Try again safely."));
      render(<EmailCodeSignIn />);
      if (operation === "create" || operation === "prepare") {
        fireEvent.change(screen.getByLabelText("Email address"), {
          target: { value: "member@example.test" },
        });
        fireEvent.click(
          screen.getByRole("button", { name: "Send verification code" }),
        );
      } else {
        await start();
        verify();
      }
      expect((await screen.findByRole("alert")).textContent).toContain(
        "Try again safely.",
      );
      expect(h.assign).not.toHaveBeenCalled();
    },
  );
  it("keeps a valid existing session even when an invitation link is opened", async () => {
    h.auth.isSignedIn = true;
    location("?__clerk_ticket=invite&__clerk_status=sign_up");
    render(<EmailCodeSignIn />);
    await waitFor(() =>
      expect(h.setLocation).toHaveBeenCalledWith("/app", { replace: true }),
    );
    expect(h.create).not.toHaveBeenCalled();
    expect(h.prepare).not.toHaveBeenCalled();
  });
});
