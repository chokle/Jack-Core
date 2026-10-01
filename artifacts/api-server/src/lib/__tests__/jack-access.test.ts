import { createHash } from "node:crypto";
import type { Request } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  data: {} as Record<string, Array<Record<string, unknown>>>,
  identity: vi.fn(),
  error: false,
}));
vi.mock("../admin-auth.js", () => ({ resolveIdentity: h.identity }));
vi.mock("../supabase.js", () => ({
  supabase: {
    from: (table: string) => {
      const filters: Array<(row: Record<string, unknown>) => boolean> = [];
      let single = false;
      const query = {
        select: () => query,
        order: () => query,
        eq: (key: string, value: unknown) => {
          filters.push((row) => row[key] === value);
          return query;
        },
        in: (key: string, values: unknown[]) => {
          filters.push((row) => values.includes(row[key]));
          return query;
        },
        maybeSingle: () => {
          single = true;
          return query;
        },
        then: (resolve: (result: unknown) => unknown) => {
          const rows = (h.data[table] ?? []).filter((row) =>
            filters.every((filter) => filter(row)),
          );
          return Promise.resolve(
            resolve({
              data: single ? (rows[0] ?? null) : rows,
              error: h.error ? new Error("database unavailable") : null,
            }),
          );
        },
      };
      return query;
    },
  },
}));
import {
  inviteOrganizations,
  jackAccessContext,
  resolveJackOrganizations,
} from "../jack-access.js";
import { isEligibleSiteMember } from "../site-mapping-access.js";

beforeEach(() => {
  h.error = false;
  h.identity.mockReset().mockResolvedValue({
    userId: "user_a",
    classification: "resolved",
    isAdmin: false,
    isPresentation: false,
  });
  h.data = {
    organizations: [
      { id: "org_a", name: "Our tenant", status: "active" },
      { id: "org_b", name: "Other tenant", status: "active" },
    ],
    jack_memberships: [
      {
        organization_id: "org_a",
        user_id: "user_a",
        role: "champion",
        active: true,
      },
      {
        organization_id: "org_b",
        user_id: "user_b",
        role: "member",
        active: true,
      },
    ],
  };
});
describe("Jack tenant membership", () => {
  it("gives a champion their own tenant without admin or pilot-report authority", async () => {
    const result = await jackAccessContext({} as Request);
    expect(result).toEqual({
      allowed: true,
      canInvite: false,
      organizations: [{ id: "org_a", name: "Our tenant", role: "champion" }],
    });
    expect(await inviteOrganizations(await h.identity())).toEqual([]);
  });
  it("permits a member independently of all pilot cohorts", async () => {
    h.data.jack_memberships![0]!.role = "member";
    expect((await jackAccessContext({} as Request)).allowed).toBe(true);
  });
  it("does not admit revoked members or memberships in inactive organizations", async () => {
    h.data.jack_memberships![0]!.active = false;
    expect(await resolveJackOrganizations("user_a")).toEqual([]);
    h.data.jack_memberships![0]!.active = true;
    h.data.organizations![0]!.status = "inactive";
    expect(await resolveJackOrganizations("user_a")).toEqual([]);
  });
  it("keeps legacy current testers and organization admins working", async () => {
    h.data.jack_memberships = [];
    h.data.pilot_memberships = [
      {
        organization_id: "org_a",
        pilot_id: "pilot_a",
        user_id: "user_a",
        role: "tester",
        active: true,
        valid_from: "2020-01-01T00:00:00Z",
        valid_until: null,
      },
    ];
    h.data.pilots = [
      { id: "pilot_a", organization_id: "org_a", status: "active" },
    ];
    expect((await resolveJackOrganizations("user_a"))[0]?.role).toBe("tester");
    h.data.pilot_memberships![0]!.role = "organization_admin";
    h.data.pilot_memberships![0]!.pilot_id = null;
    expect((await jackAccessContext({} as Request)).canInvite).toBe(true);
    expect(await inviteOrganizations(await h.identity())).toEqual([
      { id: "org_a", name: "Our tenant" },
    ]);
  });
  it("does not treat invalid, expired, or future legacy windows as authorization", async () => {
    h.data.jack_memberships = [];
    for (const dates of [
      { valid_from: "bad" },
      { valid_until: "2020-01-01" },
      { valid_from: "2999-01-01" },
    ]) {
      h.data.pilot_memberships = [
        {
          organization_id: "org_a",
          pilot_id: null,
          user_id: "user_a",
          role: "organization_admin",
          active: true,
          ...dates,
        },
      ];
      expect(await resolveJackOrganizations("user_a")).toEqual([]);
    }
  });
  it("refuses a pilot membership whose pilot belongs to another organization", async () => {
    h.data.jack_memberships = [];
    h.data.pilot_memberships = [
      {
        organization_id: "org_a",
        pilot_id: "pilot_b",
        user_id: "user_a",
        role: "tester",
        active: true,
      },
    ];
    h.data.pilots = [
      { id: "pilot_b", organization_id: "org_b", status: "active" },
    ];
    expect(await resolveJackOrganizations("user_a")).toEqual([]);
  });
  it("does not turn a champion into an eligible member of another tenant's site", async () => {
    expect(await isEligibleSiteMember("user_a", "org_a")).toBe(true);
    expect(await isEligibleSiteMember("user_a", "org_b")).toBe(false);
  });
  it("refuses unresolved and restricted identities even with a membership", async () => {
    h.identity.mockResolvedValue({
      userId: "user_a",
      classification: "unavailable",
      isAdmin: true,
    });
    expect((await jackAccessContext({} as Request)).allowed).toBe(false);
    h.identity.mockResolvedValue({
      userId: "user_a",
      classification: "resolved",
      isPresentation: true,
      isAdmin: true,
    });
    expect((await jackAccessContext({} as Request)).allowed).toBe(false);
  });
  it("fails closed when database authorization is unavailable", async () => {
    h.error = true;
    await expect(resolveJackOrganizations("user_a")).rejects.toThrow(
      "database unavailable",
    );
  });
  it("denies a deleted platform admin before access or invitation shortcuts", async () => {
    h.data.jack_access_deleted_accounts = [
      { subject_hash: createHash("sha256").update("user_a").digest("hex") },
    ];
    h.identity.mockResolvedValue({
      userId: "user_a",
      classification: "resolved",
      isAdmin: true,
      isPresentation: false,
    });
    expect(await jackAccessContext({} as Request)).toEqual({
      allowed: false,
      organizations: [],
      canInvite: false,
    });
    expect(await inviteOrganizations(await h.identity())).toEqual([]);
    expect(await isEligibleSiteMember("user_a", "org_a")).toBe(false);
  });
  it("honors the permanent account-deletion fence", async () => {
    h.data.jack_access_deleted_accounts = [
      { subject_hash: createHash("sha256").update("user_a").digest("hex") },
    ];
    expect(await resolveJackOrganizations("user_a")).toEqual([]);
  });
});
