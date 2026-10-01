// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { InviteUsers, type InvitationReceipt } from "./InviteUsers";
const h = vi.hoisted(() => ({
  request: vi.fn(),
  send: vi.fn(),
  revoke: vi.fn(),
  canInvite: true,
  userId: "admin-a",
}));
vi.mock("./JackAccess", () => ({
  accessRequest: h.request,
  useJackAccess: () => ({ canInvite: h.canInvite }),
}));
vi.mock("@clerk/react", () => ({ useAuth: () => ({ userId: h.userId }) }));
const orgA = "11111111-1111-4111-8111-111111111111";
const orgB = "22222222-2222-4222-8222-222222222222";
const receipt: InvitationReceipt = {
  id: "invite-a",
  organizationId: orgA,
  email: "rob@example.test",
  role: "champion",
  status: "pending",
  deliveryStatus: "sent",
  expiresAt: "2026-10-10T12:00:00Z",
};
beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  h.canInvite = true;
  h.userId = "admin-a";
  h.send.mockResolvedValue(receipt);
  h.revoke.mockResolvedValue(undefined);
  h.request.mockImplementation(async (path, options) => {
    if (path === "/api/access/organizations")
      return {
        organizations: [
          { id: orgA, name: "Org A" },
          { id: orgB, name: "Org B" },
        ],
      };
    if (options?.method === "POST") return h.send(JSON.parse(options.body));
    if (options?.method === "DELETE") return h.revoke(path);
    return { invitations: [] };
  });
});
afterEach(cleanup);
async function form() {
  render(<InviteUsers />);
  await screen.findByLabelText("Email address");
  fireEvent.change(screen.getByLabelText("Email address"), {
    target: { value: "ROB@example.test" },
  });
  fireEvent.change(screen.getByLabelText("Role"), {
    target: { value: "champion" },
  });
}
describe("organization invitations", () => {
  it("limits available organizations and roles and sends a UUID-scoped champion invitation", async () => {
    await form();
    expect(
      screen.getAllByRole("option").map((item) => item.textContent),
    ).toEqual(["Org A", "Org B", "Member", "Champion / demo"]);
    fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    await screen.findByText("Invitation sent.");
    expect(h.send).toHaveBeenCalledWith({
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      organizationId: orgA,
      email: "rob@example.test",
      role: "champion",
    });
    expect(
      sessionStorage.getItem("jack.invitation.pending.v1:admin-a"),
    ).toBeNull();
  });
  it("denies champion/admin controls when the server does not grant invite permission", () => {
    h.canInvite = false;
    render(<InviteUsers />);
    expect(screen.queryByLabelText("Email address")).toBeNull();
    expect(h.request).not.toHaveBeenCalled();
  });
  it("reuses the same request after a network failure and prevents changed payload retries", async () => {
    h.send.mockRejectedValueOnce(new Error("timeout"));
    await form();
    fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    await screen.findByRole("alert");
    const first = h.send.mock.calls[0][0];
    expect(
      (screen.getByLabelText("Organization") as HTMLSelectElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByLabelText("Email address") as HTMLInputElement).disabled,
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: "Check delivery / retry request" }),
    );
    await screen.findByText("Invitation sent.");
    expect(h.send.mock.calls[1][0]).toEqual(first);
  });
  it("persists unknown-delivery requests across reload and rechecks without duplicate send identity", async () => {
    h.send.mockResolvedValue({ ...receipt, deliveryStatus: "unknown" });
    await form();
    fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    await screen.findByText(/Delivery is not confirmed yet/);
    const first = h.send.mock.calls[0][0];
    cleanup();
    render(<InviteUsers />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Check delivery / retry request",
      }),
    );
    await waitFor(() => expect(h.send).toHaveBeenCalledTimes(2));
    expect(h.send.mock.calls[1][0]).toEqual(first);
  });
  it("does not send when request intent cannot be persisted", async () => {
    await form();
    const storage = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("unavailable");
      });
    fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    await screen.findByRole("alert");
    expect(h.send).not.toHaveBeenCalled();
    storage.mockRestore();
  });
  it("revokes a pending invitation and stops offering its revoke action", async () => {
    await form();
    fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Revoke invitation for rob@example.test",
      }),
    );
    await screen.findByText(
      "Invitation revoked. Any access granted by this invitation has also been removed.",
    );
    expect(h.revoke).toHaveBeenCalledWith("/api/access/invitations/invite-a");
    expect(
      screen.queryByRole("button", { name: /Revoke invitation/ }),
    ).toBeNull();
  });
  it("does not restore another admin's uncertain request after account switching", async () => {
    h.send.mockRejectedValueOnce(new Error("timeout"));
    await form();
    fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    await screen.findByRole("alert");
    cleanup();
    h.userId = "admin-b";
    render(<InviteUsers />);
    const email = await screen.findByLabelText("Email address");
    expect((email as HTMLInputElement).value).toBe("");
    expect(
      screen.queryByRole("button", { name: "Check delivery / retry request" }),
    ).toBeNull();
  });
  it("labels accepted invitation revocation as removal of access", async () => {
    h.send.mockResolvedValue({ ...receipt, status: "accepted" });
    await form();
    fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Revoke access for rob@example.test",
      }),
    );
    await screen.findByText(
      "Invitation revoked. Any access granted by this invitation has also been removed.",
    );
    expect(h.revoke).toHaveBeenCalledOnce();
  });
  it("creates a replacement request only after an unknown-delivery invitation is revoked", async () => {
    h.send.mockResolvedValueOnce({ ...receipt, deliveryStatus: "unknown" });
    await form();
    fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    await screen.findByText(/Delivery is not confirmed yet/);
    const original = h.send.mock.calls[0][0].requestId;
    fireEvent.click(
      screen.getByRole("button", {
        name: "Revoke invitation for rob@example.test",
      }),
    );
    await screen.findByText(/Invitation revoked\./);
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "rob@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    await screen.findByText("Invitation sent.");
    expect(h.send.mock.calls[1][0].requestId).not.toBe(original);
  });
});
