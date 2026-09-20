/**
 * Clerk Frontend API proxy configuration.
 *
 * Transport, header forwarding, body streaming, redirect rewriting, and Clerk
 * handshake proxy semantics are delegated to @clerk/express. Keeping only the
 * path/enablement policy here avoids maintaining a second auth-proxy
 * implementation beside clerkMiddleware().
 */

import type { IncomingHttpHeaders } from "node:http";

export const CLERK_PROXY_PATH = "/api/__clerk";

export function sanitizeClerkProxyHeaders(
  path: string,
  headers: IncomingHttpHeaders,
): void {
  if (path !== CLERK_PROXY_PATH && !path.startsWith(`${CLERK_PROXY_PATH}/`))
    return;
  const cfIp = headers["cf-connecting-ip"];
  const clientIp = (Array.isArray(cfIp) ? cfIp[0] : cfIp)
    ?.split(",")[0]
    ?.trim();
  if (clientIp) headers["x-forwarded-for"] = clientIp;
  // Replaying inbound edge identity to Clerk's Cloudflare edge causes error1000.
  delete headers["cf-connecting-ip"];
  delete headers["cf-connecting-ipv6"];
}

export function clerkFrontendApiProxyOptions(nodeEnv = process.env.NODE_ENV): {
  enabled: boolean;
  path: string;
} {
  return {
    enabled: nodeEnv === "production",
    path: CLERK_PROXY_PATH,
  };
}
