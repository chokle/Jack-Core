import type { Request, Response } from "express";
import { randomUUID } from "crypto";

/**
 * Session cookie shared by chat and Parking Lot chat-sourced rows. The cookie
 * is HttpOnly so JavaScript cannot read or overwrite it, and SameSite=Strict
 * prevents cross-site use. Session identity is owned by the server via this
 * cookie only — never by a client-supplied body/query value — so no caller
 * can impersonate or hijack another user's conversation.
 */
export const SESSION_COOKIE = "jack_session";

export const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "strict" as const,
  // Scope to /api so the session cookie is never sent to the frontend origin.
  path: "/api",
  // 30-day lifetime — long enough to feel persistent, bounded for cleanup.
  maxAge: 60 * 60 * 24 * 30,
  // Only set Secure in production so local dev works over http.
  secure: process.env["NODE_ENV"] === "production",
};

/**
 * Read the caller's session ID from the HttpOnly cookie. If none exists, mint
 * a new UUID, set the cookie, and return the new value. Use this on write
 * paths that need a session to exist (e.g. posting a chat message or parking
 * a thought).
 */
export function resolveSession(req: Request, res: Response): string {
  const existing = req.cookies?.[SESSION_COOKIE];
  if (typeof existing === "string" && existing.length > 0) return existing;
  const fresh = randomUUID();
  res.cookie(SESSION_COOKIE, fresh, COOKIE_OPTS);
  return fresh;
}

/**
 * Read the caller's session ID without minting one. Use this on read paths
 * (e.g. listing chat history or parked thoughts) where a missing cookie just
 * means "nothing to show yet", not "create a new session".
 */
export function readSession(req: Request): string | null {
  const existing = req.cookies?.[SESSION_COOKIE];
  return typeof existing === "string" && existing.length > 0 ? existing : null;
}
