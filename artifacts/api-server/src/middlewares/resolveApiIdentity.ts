import { getAuth } from "@clerk/express";
import type { NextFunction, Request, Response } from "express";

export const PRESENTATION_USER_ID = "presentation-demo";

/**
 * Preserve public presentation reads while ensuring a verified Clerk subject
 * always owns authenticated data. The synthetic presentation identity is not
 * an authenticated user and must never satisfy owner-only route checks.
 */
export function resolveApiIdentity(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  try {
    req.userId = getAuth(req)?.userId ?? PRESENTATION_USER_ID;
  } catch (err) {
    req.log?.warn({ err }, "getAuth failed while resolving API identity");
    req.userId = PRESENTATION_USER_ID;
  }
  next();
}
