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

const completeSession = { status: "complete", createdSessionId: "session_123" };

beforeEach(() => {
  vi.clearAllMocks();
  h.prepare.mockResolvedValue({});
  h.attempt.mockResolvedValue(completeSession);
  h.create.mockResolvedValue({
    supportedFirstFactors: [
      { strategy: "email_code", emailAddressId: "email_123" },
      { strategy: "password" },
    ],
    prepareFirstFactor: h.prepare,
  });
});

afterEach(cleanup);

describe("EmailCodeSignIn", () => {
  it("prefers password sign-in when both password and code are enabled", async () => {
    render(<EmailCodeSignIn />);

    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "pilot@torchlabs.ca" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await screen.findByLabelText("Password");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "mypassword" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect(h.attempt).toHaveBeenCalledWith({
        strategy: "password",
        password: "mypassword",
      }),
    );
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.setActive).toHaveBeenCalledWith({ session: "session_123" });
  });

  it("surfaces password failures as an inline alert", async () => {
    h.attempt.mockRejectedValue({
      errors: [{ longMessage: "Invalid email or password." }],
    });
    render(<EmailCodeSignIn />);

    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "pilot@torchlabs.ca" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await screen.findByLabelText("Password");
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "wrong-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "Invalid email or password.",
      ),
    );
    expect(h.setActive).not.toHaveBeenCalled();
  });

  it("preserves existing email-code sign-in flow when only email code is enabled", async () => {
    h.create.mockResolvedValue({
      supportedFirstFactors: [
        { strategy: "email_code", emailAddressId: "email_123" },
      ],
      prepareFirstFactor: h.prepare,
    });
    render(<EmailCodeSignIn />);

    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "mentor@torchlabs.ca" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await screen.findByText("Check your email");
    expect(screen.getByText(/mentor@torchlabs\.ca/)).toBeTruthy();
    expect(h.prepare).toHaveBeenCalledWith({
      strategy: "email_code",
      emailAddressId: "email_123",
    });

    fireEvent.change(screen.getByLabelText("Verification code"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect(h.attempt).toHaveBeenCalledWith({
        strategy: "email_code",
        code: "123456",
      }),
    );
    expect(h.setActive).toHaveBeenCalledWith({ session: "session_123" });
  });

  it("does not offer disabled social providers", () => {
    render(<EmailCodeSignIn />);

    expect(
      screen.queryByRole("button", { name: "Continue with Google" }),
    ).toBeNull();
    expect(screen.queryByText("or use an email code")).toBeNull();
  });
});
