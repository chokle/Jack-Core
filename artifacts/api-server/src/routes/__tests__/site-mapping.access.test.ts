import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const scope = vi.hoisted(() => vi.fn());
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
  hasOrganizationAuthority: async () => false,
  isEligibleSiteMember: async () => false,
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
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve(resolve({ data: [], error: null })),
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
  databaseTables.length = 0;
  databaseFilters.length = 0;
});

describe("site scan access", () => {
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
});
