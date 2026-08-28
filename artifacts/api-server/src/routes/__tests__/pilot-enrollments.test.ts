import { beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

vi.hoisted(() => {
  process.env["ADMIN_EMAILS"] = "admin@torchlabs.ca";
  process.env["PILOT_ENROLLMENT_REDIRECT_URL"] = "https://jack.torchlabs.ca/app";
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

function matchingRows(table: keyof typeof rows, filters: Array<[string, unknown]>) {
  return rows[table].filter((row) =>
    filters.every(([column, value]) => row[column] === value),
  );
}

const from = vi.hoisted(() =>
  vi.fn((table: keyof typeof rows) => {
    const filters: Array<[string, unknown]> = [];
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn((column: string, value: unknown) => {
        filters.push([column, value]);
        return query;
      }),
      limit: vi.fn(async (count: number) => ({
        data: matchingRows(table, filters).slice(0, count),
        error: null,
      })),
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
  getAuth.mockReturnValue({ userId: role === "admin" ? "u_admin" : "u_regular" });
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
    expect(JSON.stringify(response.body)).not.toContain("secret-ticket-never-returned-directly");
    expect(response.headers["cache-control"]).toContain("no-store");
  });
});

describe("GET /pilot-enrollments", () => {
  it("lists active accounts with activity counts so dormant accounts are visible", async () => {
    signInAs("admin");
    rows.pilot_memberships.push({
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
