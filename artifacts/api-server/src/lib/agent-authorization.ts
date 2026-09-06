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
  const target =
    "(?:dex|foreman\\s+agent|sweeper|journeyman\\s+agent|internal\\s+(?:ai\\s+)?agents?)";
  const normalized = message.normalize("NFKC").trim();
  // Names in questions, technical terms and coworker references are not commands.
  // Recognize direct addressing and explicit delegation; capabilities still
  // enforce admin authorization independently of this deliberately narrow guard.
  return (
    new RegExp(
      `^(?:hey\\s+)?${target}\\b(?:\\s*[,!:]|\\s+(?:please|start|stop|run|dispatch|interrupt|reprioritize|route|show|report|help)\\b)`,
      "i",
    ).test(normalized) ||
    new RegExp(
      `\\b(?:ask|tell|instruct|command|run|dispatch|interrupt|reprioritize|route)\\s+(?:the\\s+)?(?:agent\\s+)?${target}\\b`,
      "i",
    ).test(normalized)
  );
}
