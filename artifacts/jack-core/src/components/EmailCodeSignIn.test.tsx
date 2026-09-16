// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EmailCodeSignIn } from "./EmailCodeSignIn";

type FetchMockResponse = {
  ok: boolean;
  json: () => Promise<unknown>;
};

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  assign: vi.fn(),
  create: vi.fn(),
  prepare: vi.fn(),
  attempt: vi.fn(),
  setActive: vi.fn(),
  setLocation: vi.fn(),
  auth: {
    isLoaded: true,
    isSignedIn: false,
  },
}));

vi.mock("@clerk/react", () => ({
  useAuth: () => h.auth,
}));

vi.mock("@clerk/react/legacy", () => ({
  useSignIn: () => ({
    isLoaded: true,
    signIn: {
      create: h.create,
      attemptFirstFactor: h.attempt,
    },
    setActive: h.setActive,
  }),
}));

vi.mock("wouter", () => ({
  useLocation: () => ["/sign-in", h.setLocation],
}));

let originalLocation: Location;

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.isLoaded = true;
  h.auth.isSignedIn = false;
  originalLocation = window.location;
  h.fetch.mockReset();
  h.assign.mockReset();
  h.fetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      url: "/app?connected=1",
    }),
  } as FetchMockResponse);
  h.prepare.mockResolvedValue({});
  h.create.mockResolvedValue({
    supportedFirstFactors: [
      { strategy: "email_code", emailAddressId: "email_admin" },
    ],
    prepareFirstFactor: h.prepare,
  });
  h.attempt.mockResolvedValue({
    status: "complete",
    createdSessionId: "sess_admin",
  });
  h.setActive.mockResolvedValue({});
  vi.spyOn(window, "fetch").mockImplementation(h.fetch);
  Object.defineProperty(window, "location", {
    value: {
      ...window.location,
      assign: h.assign,
    },
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "location", {
    value: originalLocation,
    configurable: true,
  });
  vi.restoreAllMocks();
});

describe("EmailCodeSignIn", () => {
  it("starts direct pilot sign-in from email and redirects to Clerk session URL", async () => {
    render(<EmailCodeSignIn />);

    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "NICK@torchlabs.ca" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1));

    expect(h.fetch).toHaveBeenCalledWith(
      "/api/pilot-direct-access",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier: "nick@torchlabs.ca" }),
      }),
    );
    expect(h.assign).toHaveBeenCalledWith("/app?connected=1");
    expect(h.create).not.toHaveBeenCalled();
  });

  it("surfaces pilot endpoint errors instead of leaving the form idle", async () => {
    h.fetch.mockResolvedValue({
      ok: false,
      json: async () => ({ error: "Not configured for direct pilot sign-in." }),
    } as FetchMockResponse);

    render(<EmailCodeSignIn />);

    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "missing@torchlabs.ca" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("alert").textContent).toContain(
      "Not configured for direct pilot sign-in.",
    );
    expect(h.assign).not.toHaveBeenCalled();
  });

  it("keeps founder/admin sign-in on Clerk email verification instead of pilot direct access", async () => {
    render(<EmailCodeSignIn />);

    fireEvent.click(
      screen.getByRole("button", { name: "Torch admin / founder sign in" }),
    );
    expect(
      screen.getByRole("heading", { name: "Torch admin access" }),
    ).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Torch account email"), {
      target: { value: "DEREK@torchlabs.ca" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Send verification code" }),
    );

    await screen.findByText("Check your email");
    expect(h.create).toHaveBeenCalledWith({ identifier: "derek@torchlabs.ca" });
    expect(h.prepare).toHaveBeenCalledWith({
      strategy: "email_code",
      emailAddressId: "email_admin",
    });
    expect(h.fetch).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Verification code"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(h.attempt).toHaveBeenCalledTimes(1));
    expect(h.attempt).toHaveBeenCalledWith({
      strategy: "email_code",
      code: "123456",
    });
    expect(h.setActive).toHaveBeenCalledWith({ session: "sess_admin" });
    expect(h.assign).toHaveBeenCalledWith("/app");
  });

  it("recovers an already-authenticated user to the app instead of showing sign-in again", async () => {
    h.auth.isSignedIn = true;
    render(<EmailCodeSignIn />);

    await waitFor(() =>
      expect(h.setLocation).toHaveBeenCalledWith("/app", { replace: true }),
    );
    expect(
      screen.queryByRole("heading", { name: /pilot participant access/i }),
    ).toBeNull();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });

  it("does not offer disabled social providers", () => {
    render(<EmailCodeSignIn />);

    expect(screen.queryByRole("button", { name: "Continue with Google" })).toBeNull();
    expect(screen.queryByText("or use an email code")).toBeNull();
  });
});
