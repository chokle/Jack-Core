import type { CallerIdentity } from "./admin-auth.js";

/** Capability checks apply to every ingress, including future model/tool calls. */
export function isInternalAgentPermission(permission: string): boolean {
  return /^(agent\.(command|interrupt|dispatch)\.[a-z][a-z0-9_.-]*|agent\.status\.internal|agent\.model\.route)$/.test(
    permission,
  );
}

export function canControlInternalAgents(
  identity: CallerIdentity | null,
): boolean {
  return (
    !!identity &&
    identity.classification === "resolved" &&
    identity.isAdmin &&
    !identity.isPresentation
  );
}

export function authorizeAgentPermission(
  identity: CallerIdentity | null,
  permission: string,
): boolean {
  return (
    isInternalAgentPermission(permission) && canControlInternalAgents(identity)
  );
}

/** UX guard only. The capability boundary above, never natural-language matching,
 * is the security control. Ordinary Jack chat has no agent execution capability. */
export function addressesInternalAgent(message: string): boolean {
  return /\b(dex|foreman\s+agent|sweeper|journeyman\s+agent|internal\s+(?:ai\s+)?agents?)\b/i.test(
    message.normalize("NFKC"),
  );
}
