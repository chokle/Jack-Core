import { beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

vi.hoisted(() => {
  process.env["PILOT_DIRECT_ACCESS_EMAILS"] = "nick@torchlabs.ca";
  process.env["PILOT_DIRECT_ACCESS_REDIRECT"] = "https://jack.torchlabs.ca/app";
});

const getUserList = vi.hoisted(() => vi.fn());
const createSignInToken = vi.hoisted(() => vi.fn());
const resolveActiveTesterScope = vi.hoisted(() => vi.fn());

vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: { getUserList },
    signInTokens: { createSignInToken },
  },
}));

vi.mock("../../lib/activity-telemetry.js", () => ({
  resolveActiveTesterScope,
}));

import pilotDirectAccessRouter from "../pilot-direct-access.js";

function app(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api/pilot-direct-access", pilotDirectAccessRouter);
  return app;
}

describe("POST /api/pilot-direct-access", () => {
  beforeEach(() => {
    process.env["PILOT_DIRECT_ACCESS_EMAILS"] = "nick@torchlabs.ca";
    process.env["PILOT_DIRECT_ACCESS_REDIRECT"] = "https://jack.torchlabs.ca/app";
    getUserList.mockReset();
    createSignInToken.mockReset();
    resolveActiveTesterScope.mockReset();
  });

  it("rejects malformed identities", async () => {
    const response = await request(app())
      .post("/api/pilot-direct-access")
      .send({ email: "not-an-email" });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: "Please provide a valid pilot email address.",
    });
    expect(response.headers["cache-control"]).toBeUndefined();
  });

  it("fails closed when the direct-access allowlist is missing", async () => {
    delete process.env["PILOT_DIRECT_ACCESS_EMAILS"];

    const response = await request(app())
      .post("/api/pilot-direct-access")
      .send({ identifier: "nick@torchlabs.ca" });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error:
        "Direct sign-in could not be completed. Contact a pilot admin for approval.",
    });
    expect(getUserList).not.toHaveBeenCalled();
  });

  it("fails closed when the direct-access allowlist is empty", async () => {
    process.env["PILOT_DIRECT_ACCESS_EMAILS"] = "   ";

    const response = await request(app())
      .post("/api/pilot-direct-access")
      .send({ identifier: "nick@torchlabs.ca" });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error:
        "Direct sign-in could not be completed. Contact a pilot admin for approval.",
    });
    expect(getUserList).not.toHaveBeenCalled();
  });

  it("enforces allowlist matching without disclosing the submitted identity", async () => {
    const response = await request(app())
      .post("/api/pilot-direct-access")
      .send({ identifier: "other@torchlabs.ca" });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error:
        "Direct sign-in could not be completed. Contact a pilot admin for approval.",
    });
    expect(JSON.stringify(response.body)).not.toContain("other@torchlabs.ca");
    expect(getUserList).not.toHaveBeenCalled();
  });

  it("rejects unknown pilot email identities", async () => {
    getUserList.mockResolvedValue({ data: [], error: null });

    const response = await request(app())
      .post("/api/pilot-direct-access")
      .send({ email: "nick@torchlabs.ca" });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error:
        "Direct sign-in could not be completed. Contact a pilot admin for approval.",
    });
    expect(response.headers["cache-control"]).toBeUndefined();
  });

  it("rejects users without an active pilot membership", async () => {
    getUserList.mockResolvedValue({
      data: [{ id: "user_001" }],
      error: null,
    });
    resolveActiveTesterScope.mockResolvedValue({ scope: null, reason: "not_enrolled" });

    const response = await request(app())
      .post("/api/pilot-direct-access")
      .send({ identifier: "nick@torchlabs.ca" });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error:
        "Direct sign-in could not be completed. Contact a pilot admin for approval.",
    });
    expect(resolveActiveTesterScope).toHaveBeenCalledWith("user_001");
    expect(createSignInToken).not.toHaveBeenCalled();
  });

  it("returns only a short-lived Clerk continuation URL for an approved participant", async () => {
    getUserList.mockResolvedValue({
      data: [{ id: "user_001" }],
      error: null,
    });
    createSignInToken.mockResolvedValue({
      url: "https://accounts.torchlabs.ca/sign-in?__clerk_ticket=abc",
      status: "pending",
    });
    resolveActiveTesterScope.mockResolvedValue({
      scope: {
        pilotId: "394314ad-782b-4683-bc5d-65a0a3ba2552",
        organizationId: "40817dd6-d2b8-4087-a6f2-f416500ab4e6",
      },
    });

    const response = await request(app())
      .post("/api/pilot-direct-access")
      .send({ identifier: "  nick@torchlabs.ca  " });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      url:
        "https://accounts.torchlabs.ca/sign-in?__clerk_ticket=abc&redirect_url=https%3A%2F%2Fjack.torchlabs.ca%2Fapp",
    });
    expect(response.body).not.toHaveProperty("userId");
    expect(response.body).not.toHaveProperty("pilotId");
    expect(response.body).not.toHaveProperty("organizationId");
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(createSignInToken).toHaveBeenCalledWith({
      userId: "user_001",
      expiresInSeconds: 900,
    });
  });

  it("returns temporary unavailable on Clerk service errors", async () => {
    getUserList.mockRejectedValue(new Error("clerk unavailable"));

    const response = await request(app())
      .post("/api/pilot-direct-access")
      .send({ identifier: "nick@torchlabs.ca" });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: "Direct sign-in is temporarily unavailable.",
    });
  });
});
