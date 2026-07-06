import type { Request, Response, NextFunction } from "express";
import { getAuth } from "@clerk/express";

/**
 * Paths (relative to the `/api` mount) reachable WITHOUT authentication:
 *   - `/`              the shallow readiness probe the deploy/uptime check pings
 *   - `/healthz`       the health endpoint
 *   - `/system-health` the cost-free vitality signal polled by the heartbeat
 *
 * Express strips the mount path inside a path-mounted middleware, so a request
 * to `/api/healthz` arrives here as `req.path === "/healthz"`. Everything else
 * under `/api` requires a signed-in Clerk user.
 */
const PUBLIC_API_PATHS: ReadonlySet<string> = new Set(["/", "/healthz", "/system-health"]);

/**
 * The server-enforced authentication boundary for the whole API. Mounted at the
 * `/api` composition layer (after `clerkMiddleware`) rather than inside routers,
 * so it protects the real app in dev and prod while leaving router unit tests —
 * which mount individual routers on a bare Express app with no Clerk middleware —
 * unaffected. Admin-only routes layer an additional `requireAdmin` check on top.
 *
 * Fail-closed: any request without a resolvable Clerk user id gets a 401.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  // CORS preflight carries no credentials — let the browser learn the real
  // request is permitted instead of 401-ing the preflight itself.
  if (req.method === "OPTIONS") {
    next();
    return;
  }

  if (PUBLIC_API_PATHS.has(req.path)) {
    next();
    return;
  }

  let userId: string | null | undefined;
  try {
    userId = getAuth(req)?.userId;
  } catch (err) {
    // getAuth throws only if clerkMiddleware did not run — treat as unauthenticated.
    req.log?.warn({ err }, "getAuth failed in requireAuth");
    userId = null;
  }

  if (!userId) {
    res.status(401).json({ error: "Unauthorized — sign in required." });
    return;
  }

  req.userId = userId;
  next();
}
