import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const scope = vi.hoisted(() => vi.fn());
const organizationAuthority = vi.hoisted(() => vi.fn());
const eligibleManager = vi.hoisted(() => vi.fn());
const eligibleMember = vi.hoisted(() => vi.fn());
const upsertMembership = vi.hoisted(() => vi.fn());
const siteRecord = vi.hoisted(() => ({
  current: null as null | {
    id: string;
    organization_id: string;
    name: string;
    status: string;
  },
}));
const listedAdmins = vi.hoisted(() => ({
  current: [] as Array<{ organization_id: string }>,
}));
const listedMemberships = vi.hoisted(() => ({
  current: [] as Array<{
    site_id: string;
    organization_id: string;
    role: string;
  }>,
}));
const listedSites = vi.hoisted(() => ({
  current: [] as Array<{
    id: string;
    organization_id: string;
    name: string;
    status: string;
  }>,
}));
const databaseTables = vi.hoisted(() => [] as string[]);
const databaseFilters = vi.hoisted(() => [] as Array<[string, unknown]>);

vi.mock("../../lib/site-mapping-access.js", () => ({
  UUID_RE: /^[0-9a-f-]{36}$/,
  resolvedSiteCaller: async () => ({
    userId: "user-a",
    classification: "resolved",
    isPresentation: false,
  }),
  resolveSiteScope: scope,
  hasOrganizationAuthority: organizationAuthority,
  hasEligibleSiteManager: eligibleManager,
  isEligibleSiteMember: eligibleMember,
}));
vi.mock("../../lib/supabase.js", () => ({
  supabase: {
    from: (table: string) => {
      databaseTables.push(table);
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => {
          databaseFilters.push([column, value]);
          return query;
        },
        order: () => query,
        limit: () => query,
        maybeSingle: async () => ({
          data: table === "site_workspaces" ? siteRecord.current : null,
          error: null,
        }),
        upsert: (...args: unknown[]) => upsertMembership(...args),
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve(
            resolve({
              data:
                table === "pilot_memberships"
                  ? listedAdmins.current
                  : table === "site_memberships"
                    ? listedMemberships.current
                    : table === "site_workspaces"
                      ? listedSites.current
                      : [],
              error: null,
            }),
          ),
      };
      return query;
    },
  },
}));

import siteMappingRouter from "../site-mapping.js";

function app() {
  const value = express();
  value.use(express.json());
  value.use((req, _res, next) => {
    req.log = { error: vi.fn() } as never;
    next();
  });
  value.use("/api", siteMappingRouter);
  return value;
}

beforeEach(() => {
  scope.mockReset();
  organizationAuthority.mockReset();
  eligibleManager.mockReset();
  eligibleMember.mockReset();
  upsertMembership.mockReset();
  siteRecord.current = null;
  listedAdmins.current = [];
  listedMemberships.current = [];
  listedSites.current = [];
  databaseTables.length = 0;
  databaseFilters.length = 0;
});

describe("site scan access", () => {
  it("lets a site manager transfer manager access to an eligible member", async () => {
    scope.mockResolvedValue({
      siteId: "11111111-1111-4111-8111-111111111111",
      organizationId: "org-a",
      role: "manager",
      status: "active",
    });
    eligibleMember.mockResolvedValue(true);
    upsertMembership.mockResolvedValue({ error: null });
    const result = await request(app())
      .put(
        "/api/site-mapping/sites/11111111-1111-4111-8111-111111111111/members/user-b",
      )
      .send({ role: "manager" });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ userId: "user-b", role: "manager" });
    expect(eligibleMember).toHaveBeenCalledWith("user-b", "org-a");
    expect(upsertMembership).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: "user-b",
        role: "manager",
        organization_id: "org-a",
      }),
      { onConflict: "site_id,user_id" },
    );
  });

  it("lists only orphaned active sites for an organization admin to recover", async () => {
    listedAdmins.current = [{ organization_id: "org-a" }];
    listedSites.current = [
      {
        id: "site-a",
        organization_id: "org-a",
        name: "Field site",
        status: "active",
      },
    ];
    organizationAuthority.mockResolvedValue(true);
    eligibleManager.mockResolvedValue(false);
    const result = await request(app()).get("/api/site-mapping/sites");
    expect(result.status).toBe(200);
    expect(result.body.sites).toEqual([]);
    expect(result.body.recoverableSites).toEqual(listedSites.current);
    expect(organizationAuthority).toHaveBeenCalledWith("user-a", "org-a");
    expect(eligibleManager).toHaveBeenCalledWith("site-a", "org-a");
  });

  it("lists an orphaned site for recovery even when the admin is already a viewer", async () => {
    listedAdmins.current = [{ organization_id: "org-a" }];
    listedMemberships.current = [
      { site_id: "site-a", organization_id: "org-a", role: "viewer" },
    ];
    listedSites.current = [
      {
        id: "site-a",
        organization_id: "org-a",
        name: "Field site",
        status: "active",
      },
    ];
    scope.mockResolvedValue({
      siteId: "site-a",
      organizationId: "org-a",
      role: "viewer",
      status: "active",
    });
    organizationAuthority.mockResolvedValue(true);
    eligibleManager.mockResolvedValue(false);
    const result = await request(app()).get("/api/site-mapping/sites");
    expect(result.status).toBe(200);
    expect(result.body.sites).toEqual([
      { ...listedSites.current[0], role: "viewer" },
    ]);
    expect(result.body.recoverableSites).toEqual(listedSites.current);
  });

  it("does not enumerate scans from a site outside the caller's scope", async () => {
    scope.mockResolvedValue(null);
    const result = await request(app()).get(
      "/api/site-mapping/sites/11111111-1111-4111-8111-111111111111/scans",
    );
    expect(result.status).toBe(404);
    expect(databaseTables).not.toContain("site_scans");
  });

  it("does not grant upload access to a site viewer", async () => {
    scope.mockResolvedValue({
      siteId: "site-a",
      organizationId: "org-a",
      status: "active",
      role: "viewer",
    });
    const result = await request(app()).get(
      "/api/site-mapping/sites/11111111-1111-4111-8111-111111111111/upload-access",
    );
    expect(result.status).toBe(404);
    expect(databaseTables).not.toContain("site_scans");
  });

  it("restricts the scan list to the resolved site and organization", async () => {
    scope.mockResolvedValue({
      siteId: "site-a",
      organizationId: "org-a",
      status: "active",
      role: "contributor",
    });
    const result = await request(app()).get(
      "/api/site-mapping/sites/11111111-1111-4111-8111-111111111111/scans",
    );
    expect(result.status).toBe(200);
    expect(databaseTables).toContain("site_scans");
    expect(databaseFilters).toEqual(
      expect.arrayContaining([
        ["site_id", "site-a"],
        ["organization_id", "org-a"],
        ["status", "uploaded"],
      ]),
    );
  });

  it("requires the Worker token for scan metadata authorization", async () => {
    const result = await request(app()).post(
      "/api/site-mapping/internal/sites/11111111-1111-4111-8111-111111111111/scans/authorize",
    );
    expect(result.status).toBe(403);
    expect(scope).not.toHaveBeenCalled();
  });

  it("does not let a different organization's user recover a site", async () => {
    siteRecord.current = {
      id: "site-a",
      organization_id: "org-a",
      name: "Field site",
      status: "active",
    };
    organizationAuthority.mockResolvedValue(false);
    const result = await request(app()).post(
      "/api/site-mapping/sites/11111111-1111-4111-8111-111111111111/recover-manager",
    );
    expect(result.status).toBe(404);
    expect(upsertMembership).not.toHaveBeenCalled();
  });

  it("keeps manager recovery closed while an eligible manager exists", async () => {
    siteRecord.current = {
      id: "site-a",
      organization_id: "org-a",
      name: "Field site",
      status: "active",
    };
    organizationAuthority.mockResolvedValue(true);
    eligibleManager.mockResolvedValue(true);
    const result = await request(app()).post(
      "/api/site-mapping/sites/11111111-1111-4111-8111-111111111111/recover-manager",
    );
    expect(result.status).toBe(409);
    expect(upsertMembership).not.toHaveBeenCalled();
  });

  it("lets an active organization admin claim an orphaned site", async () => {
    siteRecord.current = {
      id: "site-a",
      organization_id: "org-a",
      name: "Field site",
      status: "active",
    };
    organizationAuthority.mockResolvedValue(true);
    eligibleManager.mockResolvedValue(false);
    upsertMembership.mockResolvedValue({ error: null });
    const result = await request(app()).post(
      "/api/site-mapping/sites/11111111-1111-4111-8111-111111111111/recover-manager",
    );
    expect(result.status).toBe(200);
    expect(result.body.site.role).toBe("manager");
    expect(upsertMembership).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: "org-a",
        site_id: "11111111-1111-4111-8111-111111111111",
        user_id: "user-a",
        role: "manager",
      }),
      { onConflict: "site_id,user_id" },
    );
  });
});
