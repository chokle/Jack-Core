import { resolveActiveTesterScope } from "./activity-telemetry.js";
import type { KnowledgeObjectMeta } from "./knowledge-schema.js";

export interface KnowledgeScope {
  organizationId: string;
  pilotId: string;
}

/** Shared with Ask Jack retrieval: incomplete or mismatched tenant scope fails closed. */
export function knowledgeEntryScopeAllowed(
  metadata: KnowledgeObjectMeta | undefined,
  scope: KnowledgeScope | null,
): boolean {
  if (!metadata) return false;
  const metadataPilotId = metadata.pilotId;
  const metadataOrganizationId = metadata.organizationId;
  const hasPilotId = typeof metadataPilotId === "string" && !!metadataPilotId;
  const hasOrganizationId =
    typeof metadataOrganizationId === "string" && !!metadataOrganizationId;
  if (!hasPilotId && !hasOrganizationId) return true;
  if (!hasPilotId || !hasOrganizationId || !scope) return false;
  return (
    metadataPilotId === scope.pilotId &&
    metadataOrganizationId === scope.organizationId
  );
}

export async function resolveKnowledgeScope(
  userId: string,
): Promise<KnowledgeScope | null> {
  try {
    const membership = await resolveActiveTesterScope(userId);
    if (!membership.scope) return null;
    return {
      organizationId: membership.scope.organizationId,
      pilotId: membership.scope.pilotId,
    };
  } catch {
    return null;
  }
}
