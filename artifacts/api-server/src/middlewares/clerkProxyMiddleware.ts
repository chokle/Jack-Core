/**
 * Clerk Frontend API proxy configuration.
 *
 * Transport, header forwarding, body streaming, redirect rewriting, and Clerk
 * handshake proxy semantics are delegated to @clerk/express. Keeping only the
 * path/enablement policy here avoids maintaining a second auth-proxy
 * implementation beside clerkMiddleware().
 */

export const CLERK_PROXY_PATH = "/api/__clerk";

export function clerkFrontendApiProxyOptions(
  nodeEnv = process.env.NODE_ENV,
): { enabled: boolean; path: string } {
  return {
    enabled: nodeEnv === "production",
    path: CLERK_PROXY_PATH,
  };
}
