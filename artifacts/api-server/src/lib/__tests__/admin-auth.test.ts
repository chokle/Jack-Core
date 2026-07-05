/**
 * Unit tests for the signed admin session — specifically the reviewer identity
 * it now carries. A "verified" concept must be attributable to an accountable
 * human, and that name must be tamper-proof: it rides inside the HMAC-signed
 * cookie, so a client cannot forge or alter it without JACK_ADMIN_KEY.
 */
import { vi, describe, it, expect } from "vitest";
import type { Request, Response } from "express";

// admin-auth reads JACK_ADMIN_KEY at module-load time; set it before import.
const ADMIN_KEY = vi.hoisted(() => {
  const key = "test-admin-key-1234567890";
  process.env["JACK_ADMIN_KEY"] = key;
  return key;
});

import {
  createAdminSession,
  isAdminSessionValid,
  getAdminReviewer,
  normalizeReviewer,
} from "../admin-auth.js";

/** Capture the cookie value createAdminSession writes onto the response. */
function login(reviewer?: string | null): string {
  let cookie = "";
  const res = {
    cookie(name: string, value: string) {
      cookie = value;
      return this;
    },
  } as unknown as Response;
  const result = createAdminSession(ADMIN_KEY, res, reviewer);
  expect(result).toBe("ok");
  return cookie;
}

function reqWith(cookieValue: string | undefined): Request {
  return { cookies: { jack_admin_session: cookieValue } } as unknown as Request;
}

describe("admin session reviewer identity", () => {
  it("round-trips the reviewer name through the signed cookie", () => {
    const req = reqWith(login("Dana the Welder"));
    expect(isAdminSessionValid(req)).toBe(true);
    expect(getAdminReviewer(req)).toBe("Dana the Welder");
  });

  it("keeps a valid session with a null reviewer when no name is supplied", () => {
    const req = reqWith(login());
    expect(isAdminSessionValid(req)).toBe(true);
    expect(getAdminReviewer(req)).toBeNull();
  });

  it("rejects a forged cookie and exposes no reviewer", () => {
    const req = reqWith("authenticated.deadbeefsignature");
    expect(isAdminSessionValid(req)).toBe(false);
    expect(getAdminReviewer(req)).toBeNull();
  });

  it("rejects a tampered reviewer payload (signature no longer matches)", () => {
    const signed = login("Dana the Welder");
    const dot = signed.lastIndexOf(".");
    // Swap the payload for a different reviewer while keeping the old signature.
    const forgedPayload = Buffer.from(
      JSON.stringify({ v: "authenticated", reviewer: "Impostor" }),
      "utf8",
    ).toString("base64url");
    const tampered = `${forgedPayload}${signed.slice(dot)}`;
    const req = reqWith(tampered);
    expect(isAdminSessionValid(req)).toBe(false);
    expect(getAdminReviewer(req)).toBeNull();
  });

  it("normalizes reviewer names: trims, collapses whitespace, caps length", () => {
    expect(normalizeReviewer("  Dana   the   Welder  ")).toBe("Dana the Welder");
    expect(normalizeReviewer("   ")).toBeNull();
    expect(normalizeReviewer(42)).toBeNull();
    expect(normalizeReviewer("x".repeat(200))).toHaveLength(80);
  });
});
