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
}));
let originalLocation: Location;

beforeEach(() => {
  vi.clearAllMocks();
  originalLocation = window.location;
  h.fetch.mockReset();
  h.assign.mockReset();
  h.fetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      url: "/app?connected=1",
    }),
  } as FetchMockResponse);
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
  });

  it("surfaces endpoint errors instead of leaving the form idle", async () => {
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

  it("does not offer disabled social providers", () => {
    render(<EmailCodeSignIn />);

    expect(screen.queryByRole("button", { name: "Continue with Google" })).toBeNull();
    expect(screen.queryByText("or use an email code")).toBeNull();
  });
});
