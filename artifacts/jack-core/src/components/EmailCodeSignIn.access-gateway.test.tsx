// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { EmailCodeSignIn } from "./EmailCodeSignIn";

vi.mock("@clerk/react", () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: false }),
  SignIn: () => null,
  SignUp: () => null,
}));
vi.mock("@clerk/react/legacy", () => ({
  useSignIn: () => ({ isLoaded: true, signIn: {}, setActive: vi.fn() }),
  useSignUp: () => ({ isLoaded: true, signUp: {}, setActive: vi.fn() }),
}));
vi.mock("wouter", () => ({ useLocation: () => ["/sign-in", vi.fn()] }));
afterEach(cleanup);

describe("shared Jack access entry", () => {
  it("offers one email sign-in without cohort, founder, or public-demo detours", () => {
    render(<EmailCodeSignIn />);
    expect(
      screen.getByRole("heading", { name: "Sign in to Jack" }),
    ).toBeTruthy();
    expect(
      screen.getByLabelText("Email address").getAttribute("autocomplete"),
    ).toBe("email");
    expect(
      screen.getByRole("button", { name: "Send verification code" }),
    ).toBeTruthy();
    expect(
      screen.queryByText(
        /pilot participant|founder sign in|real Jack environment is restricted/i,
      ),
    ).toBeNull();
    expect(screen.queryByRole("link", { name: /demo/i })).toBeNull();
  });
});
