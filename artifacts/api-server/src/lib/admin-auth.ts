import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { logger } from "./logger.js";

const JACK_ADMIN_KEY = process.env["JACK_ADMIN_KEY"];
const COOKIE_NAME = "jack_admin_session";

if (!JACK_ADMIN_KEY) {
  logger.warn(
    "JACK_ADMIN_KEY is not set — all admin write operations will be rejected. " +
      "Set the JACK_ADMIN_KEY secret to enable library management.",
  );
}

/**
 * Sign a value with HMAC-SHA256 so the session cookie cannot be forged
 * without knowledge of JACK_ADMIN_KEY.  The cookie carries only this signed
 * token — no raw credential is ever set on the client.
 */
function sign(value: string): string {
  const key = JACK_ADMIN_KEY!;
  const sig = createHmac("sha256", key).update(value).digest("hex");
  return `${value}.${sig}`;
}

function verify(signed: string): boolean {
  const dot = signed.lastIndexOf(".");
  if (dot === -1) return false;
  const value = signed.slice(0, dot);
  const expected = sign(value);
  try {
    return timingSafeEqual(Buffer.from(signed), Buffer.from(expected));
  } catch {
    return false;
  }
}

const SESSION_VALUE = "authenticated";
const SIGNED_SESSION = () => sign(SESSION_VALUE);

/**
 * Validate the submitted password against JACK_ADMIN_KEY and, on success,
 * set an HttpOnly signed session cookie.  The raw password is compared
 * only server-side and is never echoed back.
 */
export function createAdminSession(
  password: string,
  res: Response,
): "ok" | "wrong" | "unconfigured" {
  if (!JACK_ADMIN_KEY) return "unconfigured";
  let equal = false;
  try {
    equal = timingSafeEqual(Buffer.from(password), Buffer.from(JACK_ADMIN_KEY));
  } catch {
    return "wrong";
  }
  if (!equal) return "wrong";

  res.cookie(COOKIE_NAME, SIGNED_SESSION(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env["NODE_ENV"] === "production",
    maxAge: 8 * 60 * 60 * 1000,
  });
  return "ok";
}

export function clearAdminSession(res: Response): void {
  res.clearCookie(COOKIE_NAME);
}

export function isAdminSessionValid(req: Request): boolean {
  if (!JACK_ADMIN_KEY) return false;
  const cookie = req.cookies?.[COOKIE_NAME];
  if (typeof cookie !== "string") return false;
  return verify(cookie);
}

/**
 * Express middleware that rejects requests without a valid admin session
 * cookie.  Fail-closed: if JACK_ADMIN_KEY is not configured, returns 503.
 */
export function requireAdminSession(req: Request, res: Response, next: NextFunction): void {
  if (!JACK_ADMIN_KEY) {
    res.status(503).json({
      error: "Library management is not available — the application is not fully configured.",
    });
    return;
  }
  if (!isAdminSessionValid(req)) {
    req.log.warn({ url: req.url, method: req.method }, "admin session missing or invalid");
    res.status(401).json({ error: "Unauthorized — admin session required." });
    return;
  }
  next();
}
