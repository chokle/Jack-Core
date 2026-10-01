// @vitest-environment jsdom
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { JackAccess, useJackAccess } from "./JackAccess";

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  child: vi.fn(),
  signOut: vi.fn(),
  profile: vi.fn(),
  context: vi.fn(),
  withdraw: vi.fn(),
  export: vi.fn(),
  auth: { isLoaded: true, userId: "user-a", sessionId: "session-a" },
}));
vi.mock("@workspace/api-client-react", () => ({ customFetch: h.fetch }));
vi.mock("@clerk/react", () => ({
  useAuth: () => h.auth,
  useClerk: () => ({ signOut: h.signOut, openUserProfile: h.profile }),
}));
vi.mock("../lib/user-testing/test-session-service", () => ({
  loadTelemetryContext: h.context,
  withdrawTelemetry: h.withdraw,
  exportTelemetry: h.export,
}));
const allowed = {
  allowed: true,
  canInvite: false,
  organizations: [{ id: "org-a", name: "Org A", role: "champion" }],
};
function Child() {
  const access = useJackAccess();
  useEffect(() => {
    h.child();
  }, []);
  return <p>Jack: {access?.organizations[0]?.name}</p>;
}
beforeEach(() => {
  vi.resetAllMocks();
  h.auth.userId = "user-a";
  h.auth.sessionId = "session-a";
  h.fetch.mockResolvedValue(allowed);
  h.context.mockResolvedValue({
    privacyScopes: [
      {
        pilotId: "former-pilot",
        organizationName: "Former org",
        pilotName: "Former pilot",
      },
    ],
  });
});
afterEach(cleanup);
describe("server-confirmed Jack access bootstrap", () => {
  it("claims an invite without client identity and mounts data consumers from that response alone", async () => {
    let finish!: (value: unknown) => void;
    h.fetch.mockImplementation((path) =>
      path === "/api/access/accept"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(allowed),
    );
    render(
      <JackAccess>
        <Child />
      </JackAccess>,
    );
    expect(h.child).not.toHaveBeenCalled();
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.fetch.mock.calls[0][1]).toMatchObject({
      method: "POST",
      credentials: "include",
    });
    expect(h.fetch.mock.calls[0][1].body).toBeUndefined();
    await act(async () => finish(allowed));
    await screen.findByText("Jack: Org A");
    expect(h.fetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/access/accept",
    ]);
    expect(h.child).toHaveBeenCalledOnce();
  });
  it("does not mount Jack when access is denied but retains account and former-user privacy", async () => {
    h.fetch.mockResolvedValue({ ...allowed, allowed: false });
    render(
      <JackAccess>
        <Child />
      </JackAccess>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Account & privacy" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Export telemetry" }));
    expect(h.export).toHaveBeenCalledOnce();
    fireEvent.click(
      await screen.findByRole("button", { name: "Withdraw consent" }),
    );
    await waitFor(() =>
      expect(h.withdraw).toHaveBeenCalledWith("former-pilot", [
        "telemetry",
        "screen",
        "microphone",
      ]),
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Delete my account",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(h.child).not.toHaveBeenCalled();
  });
  it("fails closed after an acceptance error and retries explicitly", async () => {
    h.fetch.mockRejectedValueOnce(new Error("offline"));
    render(
      <JackAccess>
        <Child />
      </JackAccess>,
    );
    await screen.findByText("We couldn't confirm your access");
    expect(h.child).not.toHaveBeenCalled();
    expect(h.fetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Check access again" }));
    await screen.findByText("Jack: Org A");
  });
  it("ignores an old user's late acceptance and context after account switching", async () => {
    let finish!: (value: unknown) => void;
    h.fetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const rendered = render(
      <JackAccess>
        <Child />
      </JackAccess>,
    );
    h.auth.userId = "user-b";
    h.auth.sessionId = "session-b";
    h.fetch.mockResolvedValue({ ...allowed, allowed: false });
    rendered.rerender(
      <JackAccess>
        <Child />
      </JackAccess>,
    );
    await screen.findByText("Your account is signed in");
    await act(async () => finish(allowed));
    expect(h.child).not.toHaveBeenCalled();
    expect(screen.queryByText("Jack: Org A")).toBeNull();
  });
  it("removes the old allowed surface immediately when the signed-in account changes", async () => {
    const rendered = render(
      <JackAccess>
        <Child />
      </JackAccess>,
    );
    await screen.findByText("Jack: Org A");
    h.auth.userId = "user-b";
    h.fetch.mockImplementation(() => new Promise(() => {}));
    rendered.rerender(
      <JackAccess>
        <Child />
      </JackAccess>,
    );
    expect(screen.queryByText("Jack: Org A")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Opening Jack");
  });
  it("rechecks returning sessions instead of trusting a saved client membership", async () => {
    const rendered = render(
      <JackAccess>
        <Child />
      </JackAccess>,
    );
    await screen.findByText("Jack: Org A");
    rendered.unmount();
    h.fetch.mockResolvedValue({ ...allowed, allowed: false });
    render(
      <JackAccess>
        <Child />
      </JackAccess>,
    );
    await screen.findByText("Your account is signed in");
    expect(
      h.fetch.mock.calls.filter(([path]) => path === "/api/access/accept"),
    ).toHaveLength(2);
  });
});
