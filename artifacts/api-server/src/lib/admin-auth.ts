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

/**
 * Verify a signed token and return its (still-encoded) value, or null if the
 * signature does not match — so callers can both authenticate the session and
 * read the reviewer identity carried inside it.
 */
function verifiedValue(signed: string): string | null {
  const dot = signed.lastIndexOf(".");
  if (dot === -1) return null;
  const value = signed.slice(0, dot);
  const expected = sign(value);
  try {
    return timingSafeEqual(Buffer.from(signed), Buffer.from(expected)) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The signed session no longer carries a bare "authenticated" marker: it now
 * encodes the accountable reviewer behind the session, so every gated write can
 * attribute a decision to a named human. The payload is base64url JSON (no dots,
 * so the `value.signature` split stays unambiguous) and is HMAC-signed — the
 * client cannot forge or alter the reviewer name without JACK_ADMIN_KEY.
 */
interface SessionPayload {
  v: "authenticated";
  reviewer: string | null;
}

const REVIEWER_MAX_LEN = 80;

/** Trim, collapse whitespace, and cap a submitted reviewer name; empty → null. */
export function normalizeReviewer(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/\s+/g, " ").trim().slice(0, REVIEWER_MAX_LEN);
  return cleaned.length > 0 ? cleaned : null;
}

function encodeSessionValue(reviewer: string | null): string {
  const payload: SessionPayload = { v: "authenticated", reviewer };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeSessionValue(value: string): SessionPayload | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    if (obj["v"] !== "authenticated") return null;
    return { v: "authenticated", reviewer: normalizeReviewer(obj["reviewer"]) };
  } catch {
    return null;
  }
}

/** Read + authenticate the session payload from the request cookie, or null. */
function readSession(req: Request): SessionPayload | null {
  if (!JACK_ADMIN_KEY) return null;
  const cookie = req.cookies?.[COOKIE_NAME];
  if (typeof cookie !== "string") return null;
  const value = verifiedValue(cookie);
  if (value === null) return null;
  return decodeSessionValue(value);
}

/**
 * Validate the submitted password against JACK_ADMIN_KEY and, on success,
 * set an HttpOnly signed session cookie carrying the reviewer's name.  The raw
 * password is compared only server-side and is never echoed back.
 */
export function createAdminSession(
  password: string,
  res: Response,
  reviewer?: string | null,
): "ok" | "wrong" | "unconfigured" {
  if (!JACK_ADMIN_KEY) return "unconfigured";
  let equal = false;
  try {
    equal = timingSafeEqual(Buffer.from(password), Buffer.from(JACK_ADMIN_KEY));
  } catch {
    return "wrong";
  }
  if (!equal) return "wrong";

  const signed = sign(encodeSessionValue(normalizeReviewer(reviewer)));
  res.cookie(COOKIE_NAME, signed, {
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
  return readSession(req) !== null;
}

/** The accountable reviewer behind the current session, if one is signed in. */
export function getAdminReviewer(req: Request): string | null {
  return readSession(req)?.reviewer ?? null;
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
