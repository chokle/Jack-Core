import { beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

vi.hoisted(() => {
  process.env["ADMIN_EMAILS"] = "admin@torchlabs.ca";
  process.env["PILOT_ENROLLMENT_REDIRECT_URL"] =
    "https://jack.torchlabs.ca/app";
});

const getAuth = vi.hoisted(() => vi.fn());
const getUser = vi.hoisted(() => vi.fn());
const createSignInToken = vi.hoisted(() => vi.fn());
vi.mock("@clerk/express", () => ({
  getAuth,
  clerkClient: {
    users: { getUser },
    signInTokens: { createSignInToken },
  },
}));

const PILOT_ID = "394314ad-782b-4683-bc5d-65a0a3ba2552";
const ORG_ID = "40817dd6-d2b8-4087-a6f2-f416500ab4e6";
const USER_ID = "user_pilot_two_01";

const rows = vi.hoisted(() => ({
  pilots: [] as Array<Record<string, unknown>>,
  pilot_memberships: [] as Array<Record<string, unknown>>,
  test_sessions: [] as Array<Record<string, unknown>>,
  test_events: [] as Array<Record<string, unknown>>,
}));
const queryBehavior = vi.hoisted(() => ({
  rowCap: 1_000,
  missingCountTable: "",
  failedMembershipAfter: "",
  countErrorTable: "",
}));

function matchingRows(
  table: keyof typeof rows,
  filters: Array<[string, unknown]>,
) {
  return rows[table].filter((row) =>
    filters.every(([column, value]) => row[column] === value),
  );
}

const from = vi.hoisted(() =>
  vi.fn((table: keyof typeof rows) => {
    const filters: Array<[string, unknown]> = [];
    let after: [string, string] | undefined;
    let orderBy: string | undefined;
    let rowLimit = Infinity;
    let exactCount = false;
    let head = false;
    function execute() {
      let matches = matchingRows(table, filters);
      if (after)
        matches = matches.filter((row) => String(row[after![0]]) > after![1]);
      if (orderBy) {
        matches = [...matches].sort((a, b) =>
          String(a[orderBy!]).localeCompare(String(b[orderBy!])),
        );
      }
      const error =
        (table === "pilot_memberships" &&
          after?.[1] === queryBehavior.failedMembershipAfter) ||
        table === queryBehavior.countErrorTable
          ? { message: "database unavailable" }
          : null;
      return {
        data: head
          ? null
          : matches.slice(0, Math.min(rowLimit, queryBehavior.rowCap)),
        count:
          exactCount && table !== queryBehavior.missingCountTable
            ? matches.length
            : null,
        error,
      };
    }
    const query = {
      select: vi.fn(
        (columns: string, options?: { count?: string; head?: boolean }) => {
          // The event primary key is event_id, unlike test_sessions.id. Model
          // PostgREST column validation even for HEAD/count-only queries.
          if (table === "test_events" && columns.split(",").includes("id")) {
            throw new Error("column test_events.id does not exist");
          }
          exactCount = options?.count === "exact";
          head = options?.head === true;
          return query;
        },
      ),
      eq: vi.fn((column: string, value: unknown) => {
        filters.push([column, value]);
        return query;
      }),
      gt: vi.fn((column: string, value: string) => {
        after = [column, value];
        return query;
      }),
      order: vi.fn((column: string) => {
        orderBy = column;
        return query;
      }),
      limit: vi.fn((count: number) => {
        rowLimit = count;
        return query;
      }),
      then: (resolve: (value: ReturnType<typeof execute>) => unknown) =>
        Promise.resolve(execute()).then(resolve),
      maybeSingle: vi.fn(async () => ({
        data: matchingRows(table, filters)[0] ?? null,
        error: null,
      })),
    };
    return query;
  }),
);

vi.mock("../../lib/activity-telemetry.js", () => ({
  activityDb: { from },
}));

import pilotEnrollmentsRouter from "../pilot-enrollments.js";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const noop = () => {};
    (req as unknown as { log: Record<string, () => void> }).log = {
      warn: noop,
      error: noop,
      info: noop,
      debug: noop,
    };
    next();
  });
  app.use("/api", pilotEnrollmentsRouter);
  return app;
}

const app = makeApp();

function signInAs(role: "admin" | "user") {
  getAuth.mockReturnValue({
    userId: role === "admin" ? "u_admin" : "u_regular",
  });
  const email = role === "admin" ? "admin@torchlabs.ca" : "regular@example.com";
  getUser.mockImplementation(async (userId: string) => {
    if (userId === USER_ID) {
      return {
        firstName: "Pilot",
        lastName: "Two",
        primaryEmailAddress: { emailAddress: "pilot2@torchlabs.ca" },
        emailAddresses: [{ emailAddress: "pilot2@torchlabs.ca" }],
      };
    }
    return {
      firstName: null,
      lastName: null,
      primaryEmailAddress: { emailAddress: email },
      emailAddresses: [{ emailAddress: email }],
      publicMetadata: {},
      privateMetadata: {},
    };
  });
}

beforeEach(() => {
  getAuth.mockReset();
  getUser.mockReset();
  createSignInToken.mockReset();
  from.mockClear();
  queryBehavior.rowCap = 1_000;
  queryBehavior.missingCountTable = "";
  queryBehavior.failedMembershipAfter = "";
  queryBehavior.countErrorTable = "";
  rows.pilots.splice(0);
  rows.pilot_memberships.splice(0);
  rows.test_sessions.splice(0);
  rows.test_events.splice(0);
  rows.pilots.push({
    id: PILOT_ID,
    organization_id: ORG_ID,
    name: "Pilot 2",
    status: "active",
    starts_at: "2026-08-31T07:00:00.000Z",
    ends_at: "2026-09-05T06:59:59.000Z",
  });
});

describe("POST /pilot-enrollments", () => {
  it("rejects anonymous and non-admin callers before creating a Clerk token", async () => {
    const anonymous = await request(app)
      .post("/api/pilot-enrollments")
      .send({ pilotId: PILOT_ID, userId: USER_ID });
    expect(anonymous.status).toBe(401);

    signInAs("user");
    const nonAdmin = await request(app)
      .post("/api/pilot-enrollments")
      .send({ pilotId: PILOT_ID, userId: USER_ID });
    expect(nonAdmin.status).toBe(403);
    expect(createSignInToken).not.toHaveBeenCalled();
  });

  it("refuses an account without an active membership in the selected pilot", async () => {
    signInAs("admin");

    const response = await request(app)
      .post("/api/pilot-enrollments")
      .send({ pilotId: PILOT_ID, userId: USER_ID });

    expect(response.status).toBe(403);
    expect(createSignInToken).not.toHaveBeenCalled();
  });

  it("creates a short-lived one-use Account Portal URL for an active tester", async () => {
    signInAs("admin");
    rows.pilot_memberships.push({
      id: "membership_001",
      organization_id: ORG_ID,
      pilot_id: PILOT_ID,
      user_id: USER_ID,
      role: "tester",
      active: true,
      valid_from: "2026-01-01T00:00:00.000Z",
      valid_until: "2030-01-01T00:00:00.000Z",
    });
    createSignInToken.mockResolvedValue({
      id: "sit_123",
      userId: USER_ID,
      token: "secret-ticket-never-returned-directly",
      url: "https://accounts.torchlabs.ca/sign-in?__clerk_ticket=ticket_123",
      status: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const response = await request(app)
      .post("/api/pilot-enrollments")
      .send({ pilotId: PILOT_ID, userId: USER_ID, expiresInSeconds: 900 });

    expect(response.status).toBe(201);
    expect(createSignInToken).toHaveBeenCalledWith({
      userId: USER_ID,
      expiresInSeconds: 900,
    });
    expect(response.body.oneTimeUse).toBe(true);
    expect(response.body.url).toContain("accounts.torchlabs.ca/sign-in");
    expect(response.body.url).toContain(
      "redirect_url=https%3A%2F%2Fjack.torchlabs.ca%2Fapp",
    );
    expect(JSON.stringify(response.body)).not.toContain(
      "secret-ticket-never-returned-directly",
    );
    expect(response.headers["cache-control"]).toContain("no-store");
  });
});

describe("GET /pilot-enrollments", () => {
  function membership(index: number, extra: Record<string, unknown> = {}) {
    return {
      id: `membership_${String(index).padStart(4, "0")}`,
      organization_id: ORG_ID,
      pilot_id: PILOT_ID,
      user_id: `user_${index}`,
      role: "tester",
      active: true,
      valid_from: "2026-01-01T00:00:00.000Z",
      valid_until: "2030-01-01T00:00:00.000Z",
      ...extra,
    };
  }

  it("rejects anonymous and non-admin list requests before querying pilot data", async () => {
    const anonymous = await request(app).get(
      `/api/pilot-enrollments?pilotId=${PILOT_ID}`,
    );
    expect(anonymous.status).toBe(401);
    signInAs("user");
    const nonAdmin = await request(app).get(
      `/api/pilot-enrollments?pilotId=${PILOT_ID}`,
    );
    expect(nonAdmin.status).toBe(403);
    expect(from).not.toHaveBeenCalled();
  });

  it.each([1_000, 37])(
    "returns all 205 active testers across pages with provider row cap %i",
    async (rowCap) => {
      signInAs("admin");
      queryBehavior.rowCap = rowCap;
      // Deliberately unordered input exercises stable keyset ordering, including
      // pages containing only expired members before valid participants.
      for (let index = 205; index >= 1; index--) {
        rows.pilot_memberships.push(membership(index));
      }
      for (let index = -150; index <= 0; index++) {
        rows.pilot_memberships.push(
          membership(index, { valid_until: "2020-01-01T00:00:00.000Z" }),
        );
      }
      rows.pilot_memberships.push(
        membership(206, { pilot_id: "another-pilot" }),
        membership(207, { active: false }),
        membership(208, { role: "pilot_admin" }),
        membership(209, { valid_from: "2099-01-01T00:00:00.000Z" }),
      );

      const response = await request(app).get(
        `/api/pilot-enrollments?pilotId=${PILOT_ID}`,
      );

      expect(response.status).toBe(200);
      expect(
        response.body.participants.map(
          (person: { userId: string }) => person.userId,
        ),
      ).toEqual(Array.from({ length: 205 }, (_, index) => `user_${index + 1}`));
      expect(response.headers["cache-control"]).toContain("no-store");
    },
  );

  it("counts beyond 10,000 sessions and 50,000 events without leaking other pilots or actors", async () => {
    signInAs("admin");
    queryBehavior.rowCap = 37;
    rows.pilot_memberships.push(membership(1, { user_id: USER_ID }));
    for (let index = 0; index < 10_003; index++) {
      rows.test_sessions.push({ pilot_id: PILOT_ID, actor_user_id: USER_ID });
    }
    for (let index = 0; index < 50_007; index++) {
      rows.test_events.push({ pilot_id: PILOT_ID, actor_user_id: USER_ID });
    }
    for (const table of [rows.test_sessions, rows.test_events]) {
      table.push(
        { pilot_id: "another-pilot", actor_user_id: USER_ID },
        { pilot_id: PILOT_ID, actor_user_id: "another-user" },
      );
    }

    const response = await request(app).get(
      `/api/pilot-enrollments?pilotId=${PILOT_ID}`,
    );

    expect(response.status).toBe(200);
    expect(response.body.participants[0].activity).toEqual({
      sessions: 10_003,
      events: 50_007,
    });
  });

  it("returns unavailable instead of a partial list when a later membership page fails", async () => {
    signInAs("admin");
    queryBehavior.rowCap = 1;
    rows.pilot_memberships.push(membership(1), membership(2));
    queryBehavior.failedMembershipAfter = "membership_0001";

    const response = await request(app).get(
      `/api/pilot-enrollments?pilotId=${PILOT_ID}`,
    );

    expect(response.status).toBe(503);
    expect(response.body).not.toHaveProperty("participants");
  });

  it.each(["test_sessions", "test_events"])(
    "does not convert an unavailable %s count into zero activity",
    async (table) => {
      signInAs("admin");
      rows.pilot_memberships.push(membership(1));
      queryBehavior.missingCountTable = table;
      const missing = await request(app).get(
        `/api/pilot-enrollments?pilotId=${PILOT_ID}`,
      );
      expect(missing.status).toBe(503);
      expect(missing.body).not.toHaveProperty("participants");

      queryBehavior.missingCountTable = "";
      queryBehavior.countErrorTable = table;
      const failed = await request(app).get(
        `/api/pilot-enrollments?pilotId=${PILOT_ID}`,
      );
      expect(failed.status).toBe(503);
      expect(failed.body).not.toHaveProperty("participants");
    },
  );

  it("lists active accounts with activity counts so dormant accounts are visible", async () => {
    signInAs("admin");
    rows.pilot_memberships.push({
      id: "membership_001",
      organization_id: ORG_ID,
      pilot_id: PILOT_ID,
      user_id: USER_ID,
      role: "tester",
      active: true,
      valid_from: "2026-01-01T00:00:00.000Z",
      valid_until: "2030-01-01T00:00:00.000Z",
    });
    rows.test_sessions.push({ actor_user_id: USER_ID, pilot_id: PILOT_ID });
    rows.test_events.push(
      { actor_user_id: USER_ID, pilot_id: PILOT_ID },
      { actor_user_id: USER_ID, pilot_id: PILOT_ID },
    );

    const response = await request(app).get(
      `/api/pilot-enrollments?pilotId=${PILOT_ID}`,
    );

    expect(response.status).toBe(200);
    expect(response.body.pilot.name).toBe("Pilot 2");
    expect(response.body.participants).toEqual([
      expect.objectContaining({
        userId: USER_ID,
        name: "Pilot Two",
        email: "pilot2@torchlabs.ca",
        activity: { sessions: 1, events: 2 },
      }),
    ]);
  });
});
