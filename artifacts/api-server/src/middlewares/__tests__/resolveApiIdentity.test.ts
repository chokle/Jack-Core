import { beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

const getAuth = vi.hoisted(() => vi.fn());
vi.mock("@clerk/express", () => ({ getAuth }));

import {
  PRESENTATION_USER_ID,
  resolveApiIdentity,
} from "../resolveApiIdentity.js";

function makeApp(): Express {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { log: { warn: () => void } }).log = {
      warn: () => {},
    };
    next();
  });
  app.use("/api", resolveApiIdentity);
  app.get("/api/whoami", (req, res) => {
    res.json({ userId: req.userId });
  });
  return app;
}

const app = makeApp();

beforeEach(() => {
  getAuth.mockReset();
});

describe("resolveApiIdentity", () => {
  it("preserves the verified Clerk subject for authenticated requests", async () => {
    getAuth.mockReturnValue({ userId: "user_owner" });

    const response = await request(app).get("/api/whoami");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ userId: "user_owner" });
  });

  it("uses the presentation identity only when Clerk has no signed-in user", async () => {
    getAuth.mockReturnValue({ userId: null });

    const response = await request(app).get("/api/whoami");

    expect(response.body).toEqual({ userId: PRESENTATION_USER_ID });
  });

  it("fails safely into presentation mode when Clerk state is unavailable", async () => {
    getAuth.mockImplementation(() => {
      throw new Error("missing Clerk middleware state");
    });

    const response = await request(app).get("/api/whoami");

    expect(response.body).toEqual({ userId: PRESENTATION_USER_ID });
  });
});
