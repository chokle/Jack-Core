// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { EmailCodeSignIn } from "./EmailCodeSignIn";

vi.mock("@clerk/react/legacy", () => ({
  useSignIn: () => ({
    isLoaded: true,
    signIn: null,
    setActive: vi.fn(),
  }),
}));

afterEach(() => cleanup());

describe("EmailCodeSignIn pilot access gateway", () => {
  it("keeps pilot sign-in visible and routes non-participants to the sample demo", () => {
    render(<EmailCodeSignIn />);

    expect(
      screen.getByRole("heading", { name: /pilot participant access/i }),
    ).toBeTruthy();
    expect(screen.getByText(/real Jack environment is restricted/i)).toBeTruthy();

    const demoLink = screen.getByRole("link", { name: /try jack demo/i });
    expect(demoLink.getAttribute("href")).toBe(
      "https://jack-core-demo-ycf4yh.v2.appdeploy.ai/",
    );
    expect(demoLink.getAttribute("target")).toBe("_blank");

    expect(screen.queryByRole("link", { name: /sign up/i })).toBeNull();
    expect(screen.getByLabelText(/email address/i)).toBeTruthy();
  });
});
