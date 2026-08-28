import type { NextFunction, Request, Response } from "express";
import { resolveIdentity } from "../lib/admin-auth.js";
import { resolveActiveTesterScope } from "../lib/activity-telemetry.js";
import { isPublicApiPath } from "./requireAuth.js";

function usesRouteScopedAuthorization(req: Request): boolean {
  const path = req.path.length > 1 ? req.path.replace(/\/+$/, "") : req.path;
  if (req.method === "DELETE" && path === "/account") return true;
  return path === "/testing/progress" || path.startsWith("/testing/reports");
}

/**
 * Server-enforced authorization boundary for the controlled pilot environment.
 * Authentication alone is insufficient: callers must have a current active
 * tester membership, or be an explicitly trusted platform admin.
 */
export function requirePilotAccess(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (
    req.method === "OPTIONS" ||
    isPublicApiPath(req.path) ||
    usesRouteScopedAuthorization(req)
  ) {
    next();
    return;
  }

  // Local/test bypass remains available only when deliberately enabled. The
  // production Cloudflare and Railway configurations set this to false.
  if (process.env["PILOT_AUTH_BYPASS"] === "true") {
    next();
    return;
  }

  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized — sign in required." });
    return;
  }

  void (async () => {
    const membership = await resolveActiveTesterScope(userId);
    if (membership.scope) {
      next();
      return;
    }

    // Admins retain access to the real environment for support, acceptance and
    // operations even when they are not enrolled as a tester.
    const identity = await resolveIdentity(req);
    if (identity?.isAdmin && identity.classification === "resolved") {
      next();
      return;
    }

    req.log?.warn(
      { userId, reason: membership.reason, path: req.path },
      "pilot access denied",
    );
    res.status(403).json({
      error:
        "Forbidden — an active Torch pilot membership is required for this environment.",
    });
  })().catch((err) => {
    req.log?.error({ err, userId, path: req.path }, "pilot access verification failed");
    res.status(500).json({ error: "Failed to verify pilot access." });
  });
}
