import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { requireAuth } from "../middlewares/requireAuth";

describe("Pilot001 auth bypass", () => {
  afterEach(() => {
    delete process.env.PILOT_AUTH_BYPASS;
    delete process.env.PILOT_AUTH_USER_ID;
  });

  it("admits API traffic with a stable synthetic identity when explicitly enabled", () => {
    process.env.PILOT_AUTH_BYPASS = "true";
    process.env.PILOT_AUTH_USER_ID = "pilot001-test";
    const req = { method: "GET", path: "/me" } as Request;
    const res = {} as Response;
    const next = vi.fn() as unknown as NextFunction;
    requireAuth(req, res, next);
    expect(req.userId).toBe("pilot001-test");
    expect(next).toHaveBeenCalledOnce();
  });
});
