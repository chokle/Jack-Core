/**
 * Unit tests for the Clerk admin boundary. Admin status is derived server-side
 * from the signed-in Clerk user's email allowlist or trusted public metadata —
 * never from a client-supplied field — and the reviewer identity
 * used for attribution comes from that same resolved profile. The boundary is
 * fail-closed: no session, an unknown email, or a Clerk lookup failure all
 * resolve to "not an admin".
 */
import { vi, describe, it, expect, beforeEach } from "vitest";
import type { Request } from "express";

// admin-auth reads ADMIN_EMAILS once at module-load time; set it before import.
// vi.hoisted runs before the static imports below. Deliberately mixed-case and
// space-padded to prove the allowlist is normalized.
vi.hoisted(() => {
  process.env["ADMIN_EMAILS"] = "admin@torchlabs.ca, Boss@Torchlabs.ca";
});

const getAuth = vi.hoisted(() => vi.fn());
const getUser = vi.hoisted(() => vi.fn());
vi.mock("@clerk/express", () => ({
  getAuth,
  clerkClient: { users: { getUser } },
}));

import {
  isAdminEmail,
  resolveIdentity,
  resolveAdminIdentity,
  getAdminReviewer,
} from "../admin-auth.js";

beforeEach(() => {
  getAuth.mockReset();
  getUser.mockReset();
});

/** Shape a minimal Clerk user record the way clerkClient.users.getUser returns it. */
function clerkUser(
  opts: {
    email?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    publicMetadata?: Record<string, unknown>;
    unsafeMetadata?: Record<string, unknown>;
  } = {},
) {
  const email = opts.email === undefined ? "admin@torchlabs.ca" : opts.email;
  return {
    firstName: opts.firstName ?? null,
    lastName: opts.lastName ?? null,
    primaryEmailAddress: email ? { emailAddress: email } : null,
    emailAddresses: email ? [{ emailAddress: email }] : [],
    publicMetadata: opts.publicMetadata ?? {},
    unsafeMetadata: opts.unsafeMetadata ?? {},
  };
}

describe("isAdminEmail", () => {
  it("matches allowlisted emails case-insensitively and trims whitespace", () => {
    expect(isAdminEmail("ADMIN@torchlabs.ca")).toBe(true);
    expect(isAdminEmail("  boss@torchlabs.ca  ")).toBe(true);
  });

  it("rejects non-allowlisted and empty emails", () => {
    expect(isAdminEmail("nobody@example.com")).toBe(false);
    expect(isAdminEmail("")).toBe(false);
    expect(isAdminEmail(null)).toBe(false);
    expect(isAdminEmail(undefined)).toBe(false);
  });
});

describe("resolveIdentity", () => {
  it("returns null when there is no signed-in user", async () => {
    getAuth.mockReturnValue(undefined);
    expect(await resolveIdentity({} as Request)).toBeNull();
    expect(getUser).not.toHaveBeenCalled();
  });

  it("returns null when getAuth throws (no Clerk middleware on the request)", async () => {
    getAuth.mockImplementation(() => {
      throw new Error("clerkMiddleware not mounted");
    });
    expect(await resolveIdentity({} as Request)).toBeNull();
  });

  it("marks an allowlisted user as admin with a resolved display name", async () => {
    getAuth.mockReturnValue({ userId: "u_admin" });
    getUser.mockResolvedValue(
      clerkUser({ email: "admin@torchlabs.ca", firstName: "Dana", lastName: "Welder" }),
    );

    expect(await resolveIdentity({} as Request)).toEqual({
      userId: "u_admin",
      email: "admin@torchlabs.ca",
      name: "Dana Welder",
      isAdmin: true,
    });
  });

  it("marks a signed-in non-allowlisted user as a regular (non-admin) user", async () => {
    getAuth.mockReturnValue({ userId: "u_reg" });
    getUser.mockResolvedValue(clerkUser({ email: "regular@example.com" }));

    expect(await resolveIdentity({} as Request)).toEqual({
      userId: "u_reg",
      email: "regular@example.com",
      name: null,
      isAdmin: false,
    });
  });

  it("recognizes a trusted Clerk public-metadata admin role", async () => {
    getAuth.mockReturnValue({ userId: "u_shared_admin" });
    getUser.mockResolvedValue(
      clerkUser({ email: "shared@example.com", publicMetadata: { role: "ADMIN" } }),
    );

    expect(await resolveIdentity({} as Request)).toMatchObject({
      userId: "u_shared_admin",
      email: "shared@example.com",
      isAdmin: true,
    });
  });

  it("does not trust user-writable unsafe metadata for admin access", async () => {
    getAuth.mockReturnValue({ userId: "u_spoof" });
    getUser.mockResolvedValue(
      clerkUser({ email: "spoof@example.com", unsafeMetadata: { role: "admin" } }),
    );

    expect(await resolveIdentity({} as Request)).toMatchObject({ isAdmin: false });
  });

  it("fails closed to non-admin when the Clerk user lookup throws", async () => {
    getAuth.mockReturnValue({ userId: "u_admin" });
    getUser.mockRejectedValue(new Error("clerk unavailable"));
    const req = { log: { error: vi.fn() } } as unknown as Request;

    expect(await resolveIdentity(req)).toEqual({
      userId: "u_admin",
      email: null,
      name: null,
      isAdmin: false,
    });
  });
});

describe("resolveAdminIdentity", () => {
  it("returns null for a signed-in non-admin", async () => {
    getAuth.mockReturnValue({ userId: "u_reg" });
    getUser.mockResolvedValue(clerkUser({ email: "regular@example.com" }));
    expect(await resolveAdminIdentity({} as Request)).toBeNull();
  });

  it("resolves + caches the admin identity on req.admin and reuses it", async () => {
    getAuth.mockReturnValue({ userId: "u_admin" });
    getUser.mockResolvedValue(
      clerkUser({ email: "admin@torchlabs.ca", firstName: "Dana", lastName: "Welder" }),
    );
    const req = {} as Request;

    const admin = await resolveAdminIdentity(req);
    expect(admin).toEqual({ userId: "u_admin", email: "admin@torchlabs.ca", name: "Dana Welder" });
    expect(req.admin).toBe(admin);
    expect(getAdminReviewer(req)).toBe("Dana Welder");

    // Second call must hit the cache and not re-query Clerk.
    getUser.mockClear();
    expect(await resolveAdminIdentity(req)).toBe(admin);
    expect(getUser).not.toHaveBeenCalled();
  });
});

describe("getAdminReviewer", () => {
  it("falls back to the email when the admin has no display name", async () => {
    getAuth.mockReturnValue({ userId: "u_boss" });
    getUser.mockResolvedValue(
      clerkUser({ email: "boss@torchlabs.ca", firstName: null, lastName: null }),
    );
    const req = {} as Request;
    await resolveAdminIdentity(req);
    expect(getAdminReviewer(req)).toBe("boss@torchlabs.ca");
  });

  it("returns null when no admin has been resolved onto the request", () => {
    expect(getAdminReviewer({} as Request)).toBeNull();
  });
});
