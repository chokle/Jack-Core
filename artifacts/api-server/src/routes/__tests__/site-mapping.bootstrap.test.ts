import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  isAdmin: false,
  createdOrganization: null as Record<string, unknown> | null,
  membership: null as Record<string, unknown> | null,
  failMembership: false,
  deletedOrganization: false,
}));

vi.mock("../../lib/site-mapping-access.js", () => ({
  UUID_RE: /^[0-9a-f-]{36}$/,
  resolvedSiteCaller: async () => ({
    userId: "user-a",
    classification: "resolved",
    isPresentation: false,
    isAdmin: state.isAdmin,
  }),
}));

vi.mock("../../lib/supabase.js", () => ({
  supabase: {
    from: (table: string) => {
      const query = {
        select: () => query,
        eq: () => query,
        is: () => query,
        order: () => query,
        delete: () => {
          state.deletedOrganization = true;
          return query;
        },
        insert: (row: Record<string, unknown>) => {
          if (table === "organizations") state.createdOrganization = row;
          if (table === "pilot_memberships") state.membership = row;
          return query;
        },
        single: async () => ({
          data: {
            id: state.createdOrganization?.id,
            name: state.createdOrganization?.name,
          },
          error: null,
        }),
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve(
            resolve({
              data: table === "pilot_memberships" ? [] : null,
              error:
                table === "pilot_memberships" &&
                state.membership &&
                state.failMembership
                  ? new Error("membership failed")
                  : null,
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
  state.isAdmin = false;
  state.createdOrganization = null;
  state.membership = null;
  state.failMembership = false;
  state.deletedOrganization = false;
});

describe("private pilot space bootstrap", () => {
  it("does not offer creation or accept it for ordinary signed-in users", async () => {
    const list = await request(app()).get("/api/site-mapping/organizations");
    expect(list.status).toBe(200);
    expect(list.body).toEqual({
      organizations: [],
      canCreateOrganization: false,
    });
    const create = await request(app())
      .post("/api/site-mapping/organizations")
      .send({ name: "Field pilot" });
    expect(create.status).toBe(403);
    expect(state.createdOrganization).toBeNull();
  });

  it("lets a trusted admin create a private organization and their own membership", async () => {
    state.isAdmin = true;
    const list = await request(app()).get("/api/site-mapping/organizations");
    expect(list.body.canCreateOrganization).toBe(true);
    const create = await request(app())
      .post("/api/site-mapping/organizations")
      .send({ name: "  Back alley pilot  " });
    expect(create.status).toBe(201);
    expect(create.body.organization.name).toBe("Back alley pilot");
    expect(state.createdOrganization).toEqual(
      expect.objectContaining({ name: "Back alley pilot" }),
    );
    expect(state.membership).toEqual(
      expect.objectContaining({
        organization_id: create.body.organization.id,
        user_id: "user-a",
        role: "organization_admin",
        pilot_id: null,
      }),
    );
  });

  it("rolls back an organization when admin membership fails", async () => {
    state.isAdmin = true;
    state.failMembership = true;
    const result = await request(app())
      .post("/api/site-mapping/organizations")
      .send({ name: "Field pilot" });
    expect(result.status).toBe(500);
    expect(state.deletedOrganization).toBe(true);
  });
});
