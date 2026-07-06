import type { Request, Response, NextFunction } from "express";
import { getAuth, clerkClient } from "@clerk/express";
import { logger } from "./logger.js";

/**
 * Admin access is ROLE-BASED BY EMAIL: `ADMIN_EMAILS` is a comma/whitespace
 * separated allowlist. Anyone who signs in (via Clerk) with one of these emails
 * is an admin; everyone else is a regular authenticated user. Enforcement is
 * server-side and fail-closed — if `ADMIN_EMAILS` is unset, NO ONE is an admin,
 * so admin-only routes (Knowledge Review, analytics, exports, moderation,
 * system tools) stay locked even to signed-in users.
 */
const ADMIN_EMAILS: ReadonlySet<string> = new Set(
  (process.env["ADMIN_EMAILS"] ?? "")
    .split(/[,\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0),
);

if (ADMIN_EMAILS.size === 0) {
  logger.warn(
    "ADMIN_EMAILS is not set — no user will have admin access (Knowledge Review, " +
      "analytics, exports, moderation, system tools). Set the ADMIN_EMAILS secret " +
      "(comma-separated) to grant admin access.",
  );
}

export interface AdminIdentity {
  userId: string;
  email: string;
  name: string | null;
}

export interface CallerIdentity {
  userId: string;
  email: string | null;
  name: string | null;
  isAdmin: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Clerk user id, set by the app-level `requireAuth` gate. */
      userId?: string;
      /** Resolved admin identity, set by `requireAdmin`/`resolveAdminIdentity`. */
      admin?: AdminIdentity;
    }
  }
}

/** Whether an email address is in the admin allowlist (case-insensitive). */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return ADMIN_EMAILS.has(email.trim().toLowerCase());
}

function displayName(user: { firstName: string | null; lastName: string | null }): string | null {
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return name.length > 0 ? name : null;
}

/**
 * Resolve the Clerk-authenticated caller's identity and admin status, or null
 * when there is no signed-in user. Looks the user up server-side (email is not
 * carried in the default session claims) and checks the email allowlist.
 */
export async function resolveIdentity(req: Request): Promise<CallerIdentity | null> {
  let userId: string | null | undefined;
  try {
    userId = getAuth(req)?.userId;
  } catch {
    userId = null;
  }
  if (!userId) return null;

  try {
    const user = await clerkClient.users.getUser(userId);
    const email =
      user.primaryEmailAddress?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? null;
    return { userId, email, name: displayName(user), isAdmin: isAdminEmail(email) };
  } catch (err) {
    // Fail closed: if we cannot confirm the email, the caller is not an admin.
    req.log?.error({ err, userId }, "failed to resolve Clerk user");
    return { userId, email: null, name: null, isAdmin: false };
  }
}

/**
 * Resolve the caller ONLY if they are an admin, else null. Caches the result on
 * `req.admin` so both the `requireAdmin` middleware and routes that branch on
 * admin status inline (e.g. non-pending candidate listing) share one lookup.
 */
export async function resolveAdminIdentity(req: Request): Promise<AdminIdentity | null> {
  if (req.admin) return req.admin;
  const identity = await resolveIdentity(req);
  if (!identity || !identity.isAdmin || !identity.email) return null;
  const admin: AdminIdentity = {
    userId: identity.userId,
    email: identity.email,
    name: identity.name,
  };
  req.admin = admin;
  return admin;
}

/**
 * Express middleware admitting only admin users. Fail-closed:
 *   - not signed in           → 401
 *   - signed in, not an admin → 403
 * On success stashes `req.admin` so handlers can attribute the decision to a
 * real, non-spoofable identity (never a client-supplied field).
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  void (async () => {
    let userId: string | null | undefined;
    try {
      userId = getAuth(req)?.userId;
    } catch {
      userId = null;
    }
    if (!userId) {
      res.status(401).json({ error: "Unauthorized — sign in required." });
      return;
    }
    const admin = await resolveAdminIdentity(req);
    if (!admin) {
      req.log.warn({ url: req.url, method: req.method, userId }, "admin access denied");
      res.status(403).json({ error: "Forbidden — admin access required." });
      return;
    }
    next();
  })().catch((err) => {
    req.log.error({ err }, "requireAdmin error");
    res.status(500).json({ error: "Failed to verify admin access." });
  });
}

/** The accountable reviewer behind the current admin request, for attribution. */
export function getAdminReviewer(req: Request): string | null {
  return req.admin?.name ?? req.admin?.email ?? null;
}
