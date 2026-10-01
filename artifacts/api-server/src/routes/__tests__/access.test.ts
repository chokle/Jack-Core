import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  userId: "",
  counter: 0,
  failWrites: false,
  rows: [] as Array<Record<string, unknown>>,
  identity: vi.fn(),
  organizations: vi.fn(),
  deleted: vi.fn(),
  context: vi.fn(),
  getUser: vi.fn(),
  invite: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
}));
const getUserList = vi.hoisted(() => vi.fn());
const createUser = vi.hoisted(() => vi.fn());
vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: { getUser: h.getUser, getUserList, createUser },
    invitations: { createInvitation: h.invite },
  },
}));
vi.mock("../../lib/admin-auth.js", () => ({ resolveIdentity: h.identity }));
vi.mock("../../lib/jack-access.js", () => ({
  inviteOrganizations: h.organizations,
  jackAccessContext: h.context,
  isJackAccountDeleted: h.deleted,
}));
vi.mock("../../lib/supabase.js", () => ({
  supabase: { from: h.from, rpc: h.rpc },
}));
import router from "../access.js";
const org = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const id = "33333333-3333-4333-8333-333333333333";
const input = {
  requestId: id,
  organizationId: org,
  email: "new@example.com",
  role: "champion",
};
const app = express();
app.use(express.json(), (req, _res, next) => {
  req.userId = h.userId || undefined;
  req.log = { error: vi.fn(), warn: vi.fn() } as never;
  next();
});
app.use("/api", router);

beforeEach(() => {
  vi.clearAllMocks();
  h.deleted.mockReset().mockResolvedValue(false);
  h.rows = [];
  h.failWrites = false;
  h.userId = `user_${++h.counter}`;
  h.identity.mockResolvedValue({
    userId: h.userId,
    classification: "resolved",
    isAdmin: true,
    isPresentation: false,
  });
  h.organizations.mockResolvedValue([{ id: org, name: "Team" }]);
  h.context.mockResolvedValue({
    allowed: true,
    organizations: [{ id: org, name: "Team", role: "champion" }],
    canInvite: false,
  });
  h.invite.mockResolvedValue({
    id: "inv_provider",
    url: "NEVER_EXPOSE_THIS_TOKEN",
  });
  h.getUser.mockResolvedValue({
    primaryEmailAddressId: "email_1",
    emailAddresses: [
      {
        id: "email_1",
        emailAddress: "NEW@example.com",
        verification: { status: "verified" },
      },
    ],
  });
  h.rpc.mockResolvedValue({ data: 1, error: null });
  getUserList.mockReset().mockResolvedValue({ data: [{ id: "invited_user" }] });
  createUser.mockReset().mockResolvedValue({ id: "created_user" });
  h.from.mockImplementation(() => {
    let action = "read";
    let values: Record<string, unknown> = {};
    let single = false;
    const filters: Array<[string, unknown]> = [];
    const query = {
      select: () => query,
      order: () => query,
      limit: () => query,
      eq: (key: string, value: unknown) => {
        filters.push([key, value]);
        return query;
      },
      insert: (value: Record<string, unknown>) => {
        action = "insert";
        values = value;
        return query;
      },
      update: (value: Record<string, unknown>) => {
        action = "update";
        values = value;
        return query;
      },
      maybeSingle: () => {
        single = true;
        return query;
      },
      single: () => {
        single = true;
        return query;
      },
      then: (resolve: (result: unknown) => unknown) => {
        if (action === "update" && h.failWrites)
          return Promise.resolve(
            resolve({ data: null, error: { code: "42501" } }),
          );
        let rows = h.rows.filter((row) =>
          filters.every(([key, value]) => row[key] === value),
        );
        if (action === "insert") {
          if (
            h.rows.some(
              (row) =>
                row.id === values.id ||
                (row.organization_id === values.organization_id &&
                  row.email === values.email &&
                  row.status === "pending"),
            )
          )
            return Promise.resolve(
              resolve({ data: null, error: { code: "23505" } }),
            );
          const row = {
            status: "pending",
            delivery_status: "pending",
            expires_at: "2026-10-04T00:00:00Z",
            ...values,
          };
          h.rows.push(row);
          rows = [row];
        } else if (action === "update")
          rows.forEach((row) => Object.assign(row, values));
        return Promise.resolve(
          resolve({ data: single ? (rows[0] ?? null) : rows, error: null }),
        );
      },
    };
    return query;
  });
});

describe("tenant invitations", () => {
  it("returns no stale email receipt if deletion rejects a late provider write", async () => {
    h.invite.mockImplementation(async () => {
      h.failWrites = true;
      return { id: "provider_after_deletion" };
    });
    const result = await request(app)
      .post("/api/access/invitations")
      .send(input);
    expect(result.status).toBe(503);
    expect(JSON.stringify(result.body)).not.toContain("new@example.com");
    expect(JSON.stringify(result.body)).not.toContain(
      "provider_after_deletion",
    );
  });
  it("does not send an invitation after bound recipient deletion is observed", async () => {
    h.deleted.mockImplementation(
      async (userId: string) => userId === "invited_user",
    );
    const result = await request(app)
      .post("/api/access/invitations")
      .send(input);
    expect(result.status).toBe(202);
    expect(h.invite).not.toHaveBeenCalled();
  });
  it("requires authentication even before the general access gate", async () => {
    h.userId = "";
    expect((await request(app).post("/api/access/accept")).status).toBe(401);
    expect(h.getUser).not.toHaveBeenCalled();
  });
  it("claims only the server-verified primary email, ignoring forged request identity", async () => {
    const result = await request(app)
      .post("/api/access/accept")
      .send({ email: "victim@example.com", userId: "victim", role: "admin" });
    expect(result.status).toBe(200);
    expect(h.getUser).toHaveBeenCalledWith(h.userId);
    expect(h.rpc).toHaveBeenCalledWith("accept_jack_invitations", {
      p_user_id: h.userId,
      p_email: "new@example.com",
    });
    expect(result.body.canInvite).toBe(false);
  });
  it("claims only verified addresses, including a verified secondary for an existing user", async () => {
    h.getUser.mockResolvedValue({
      primaryEmailAddressId: "primary",
      emailAddresses: [
        {
          id: "primary",
          emailAddress: "new@example.com",
          verification: { status: "unverified" },
        },
        {
          id: "secondary",
          emailAddress: "other@example.com",
          verification: { status: "verified" },
        },
      ],
    });
    expect((await request(app).post("/api/access/accept")).status).toBe(200);
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(h.rpc).toHaveBeenCalledWith("accept_jack_invitations", {
      p_user_id: h.userId,
      p_email: "other@example.com",
    });
  });

  it("provisions a passwordless reserved address before emailing a new user's invitation", async () => {
    getUserList.mockResolvedValue({ data: [] });
    h.invite.mockImplementation(async () => {
      expect(h.rows[0]?.clerk_user_id).toBe("created_user");
      return { id: "inv_provider" };
    });
    expect(
      (await request(app).post("/api/access/invitations").send(input)).status,
    ).toBe(201);
    expect(createUser).toHaveBeenCalledWith({
      emailAddress: ["new@example.com"],
      skipPasswordRequirement: true,
      emailAddressIdentificationStatus: ["reserved"],
    });
  });

  it("reuses existing accounts without resetting passwords or sessions", async () => {
    expect(
      (await request(app).post("/api/access/invitations").send(input)).status,
    ).toBe(201);
    expect(createUser).not.toHaveBeenCalled();
    expect(h.rows[0]?.clerk_user_id).toBe("invited_user");
  });

  it("does not send an invitation after unconfirmed account provisioning", async () => {
    getUserList.mockResolvedValue({ data: [] });
    createUser.mockRejectedValue(new Error("network outcome unknown"));
    expect(
      (await request(app).post("/api/access/invitations").send(input)).body
        .deliveryStatus,
    ).toBe("unknown");
    expect(h.invite).not.toHaveBeenCalled();
    await request(app).post("/api/access/invitations").send(input);
    expect(createUser).toHaveBeenCalledTimes(1);
  });
  it("denies cross-tenant invitation creation before storage or email", async () => {
    expect(
      (
        await request(app)
          .post("/api/access/invitations")
          .send({ ...input, organizationId: other })
      ).status,
    ).toBe(403);
    expect(h.from).not.toHaveBeenCalled();
    expect(h.invite).not.toHaveBeenCalled();
  });
  it.each(["admin", "organization_admin", "platform_superadmin"])(
    "rejects escalation to %s",
    async (role) => {
      expect(
        (
          await request(app)
            .post("/api/access/invitations")
            .send({ ...input, role })
        ).status,
      ).toBe(400);
      expect(h.invite).not.toHaveBeenCalled();
    },
  );
  it("persists an authorized invitation before sending and returns no login token", async () => {
    h.invite.mockImplementation(async () => {
      expect(h.rows[0]?.status).toBe("pending");
      return { id: "inv_provider", url: "SECRET" };
    });
    const result = await request(app)
      .post("/api/access/invitations")
      .send(input);
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({
      id,
      role: "champion",
      deliveryStatus: "sent",
      organizationId: org,
    });
    expect(JSON.stringify(result.body)).not.toContain("SECRET");
    expect(h.invite).toHaveBeenCalledWith(
      expect.objectContaining({
        emailAddress: "new@example.com",
        notify: true,
        ignoreExisting: true,
      }),
    );
  });
  it("reuses the durable receipt without sending a duplicate", async () => {
    await request(app).post("/api/access/invitations").send(input);
    const retry = await request(app)
      .post("/api/access/invitations")
      .send(input);
    expect(retry.status).toBe(200);
    expect(h.invite).toHaveBeenCalledTimes(1);
    expect(h.rows).toHaveLength(1);
  });
  it("does not reuse an ID for a different email or role", async () => {
    await request(app).post("/api/access/invitations").send(input);
    expect(
      (
        await request(app)
          .post("/api/access/invitations")
          .send({ ...input, role: "member" })
      ).status,
    ).toBe(409);
    expect(h.invite).toHaveBeenCalledTimes(1);
  });
  it("records unknown email delivery and never blindly repeats the side effect", async () => {
    h.invite.mockRejectedValue(new Error("network failed"));
    const result = await request(app)
      .post("/api/access/invitations")
      .send(input);
    expect(result.status).toBe(202);
    expect(result.body.deliveryStatus).toBe("unknown");
    await request(app).post("/api/access/invitations").send(input);
    expect(h.invite).toHaveBeenCalledTimes(1);
  });
  it("scopes list and revocation to the administered organization", async () => {
    h.rows.push({
      id,
      organization_id: other,
      email: "other@example.com",
      role: "member",
      status: "pending",
    });
    expect(
      (
        await request(app).get(
          `/api/access/invitations?organizationId=${other}`,
        )
      ).status,
    ).toBe(403);
    expect(
      (await request(app).get(`/api/access/invitations?organizationId=${org}`))
        .body.invitations,
    ).toEqual([]);
    expect(
      (await request(app).delete(`/api/access/invitations/${id}`)).status,
    ).toBe(404);
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("revokes with the authenticated admin attribution", async () => {
    h.rows.push({ id, organization_id: org });
    expect(
      (await request(app).delete(`/api/access/invitations/${id}`)).status,
    ).toBe(204);
    expect(h.rpc).toHaveBeenCalledWith("revoke_jack_invitation", {
      p_invitation_id: id,
      p_actor_user_id: h.userId,
    });
  });
  it("keeps invitation rate limits for authenticated admins", async () => {
    for (let n = 0; n < 20; n++)
      await request(app).post("/api/access/invitations").send({});
    expect(
      (await request(app).post("/api/access/invitations").send(input)).status,
    ).toBe(429);
    expect(h.invite).not.toHaveBeenCalled();
  });
  it("does not claim success when the provider identity or database is unavailable", async () => {
    h.getUser.mockRejectedValue(new Error("unavailable"));
    expect((await request(app).post("/api/access/accept")).status).toBe(503);
    expect(h.rpc).not.toHaveBeenCalled();
  });
});
