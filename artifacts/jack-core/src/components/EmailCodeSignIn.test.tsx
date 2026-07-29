// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EmailCodeSignIn } from "./EmailCodeSignIn";

const h = vi.hoisted(() => ({
  create: vi.fn(),
  prepare: vi.fn(),
  attempt: vi.fn(),
  setActive: vi.fn(),
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

beforeEach(() => {
  vi.clearAllMocks();
  h.prepare.mockResolvedValue({});
  h.create.mockResolvedValue({
    supportedFirstFactors: [{ strategy: "email_code", emailAddressId: "email_123" }],
    prepareFirstFactor: h.prepare,
  });
});

afterEach(cleanup);

describe("EmailCodeSignIn", () => {
  it("makes Continue start email verification and visibly advances to the code step", async () => {
    render(<EmailCodeSignIn />);

    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "mentor@torchlabs.ca" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await screen.findByText("Check your email");
    expect(screen.getByText(/mentor@torchlabs\.ca/)).toBeTruthy();
    expect(h.create).toHaveBeenCalledWith({ identifier: "mentor@torchlabs.ca" });
    expect(h.prepare).toHaveBeenCalledWith({
      strategy: "email_code",
      emailAddressId: "email_123",
    });
  });

  it("surfaces Clerk errors instead of leaving Continue apparently inert", async () => {
    h.create.mockRejectedValue({ errors: [{ longMessage: "Couldn't find your account." }] });
    render(<EmailCodeSignIn />);

    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "missing@torchlabs.ca" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Couldn't find your account."));
  });

  it("does not offer disabled social providers", () => {
    render(<EmailCodeSignIn />);

    expect(screen.queryByRole("button", { name: "Continue with Google" })).toBeNull();
    expect(screen.queryByText("or use an email code")).toBeNull();
  });
});
