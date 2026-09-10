const HYDRA_BASE_URL = "https://api.hydradb.com";
const DEFAULT_TIMEOUT_MS = 1800;
const MAX_HYDRA_MATCHES = 4;

export interface HydraKnowledgeScope {
  organizationId: string;
  pilotId: string;
}

export interface HydraRecallMatch {
  id: string;
  title: string;
  text: string;
  sourceUrl?: string;
  metadata: Record<string, unknown>;
}

export interface HydraCanonicalKnowledge {
  id: string;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
  subTenantId?: string;
}

interface HydraRecallResponse {
  chunks?: unknown;
}

function envFlag(name: string): boolean {
  return /^(1|true|yes|on)$/i.test(process.env[name] ?? "");
}

export function hydraRecallConfigured(): boolean {
  return Boolean(
    envFlag("HYDRA_DB_ENABLED") &&
      process.env["HYDRA_DB_API_KEY"] &&
      process.env["HYDRA_DB_TENANT_ID"],
  );
}

function requireHydraConfig(): { apiKey: string; tenantId: string } {
  const apiKey = process.env["HYDRA_DB_API_KEY"];
  const tenantId = process.env["HYDRA_DB_TENANT_ID"];
  if (!apiKey || !tenantId) {
    throw new Error("HYDRA_DB_API_KEY and HYDRA_DB_TENANT_ID are required");
  }
  return { apiKey, tenantId };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(
  record: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function scopeAllowed(
  metadata: Record<string, unknown>,
  scope: HydraKnowledgeScope | null,
): boolean {
  // HydraDB is a retrieval/index layer, never the authority boundary. Only
  // records explicitly emitted by Torch's canonical sync are eligible.
  if (metadata["torch_approved"] !== true) return false;

  const organizationId = firstString(metadata, "organization_id", "organizationId");
  const pilotId = firstString(metadata, "pilot_id", "pilotId");
  const scoped = Boolean(organizationId || pilotId);
  if (!scoped) return true;
  if (!organizationId || !pilotId || !scope) return false;
  return organizationId === scope.organizationId && pilotId === scope.pilotId;
}

function normalizeMatch(value: unknown): HydraRecallMatch | null {
  const row = asRecord(value);
  if (!row) return null;

  const metadata =
    asRecord(row["metadata"]) ??
    asRecord(row["source_metadata"]) ??
    asRecord(row["document_metadata"]) ??
    {};
  const text = firstString(row, "chunk_content", "content", "text", "body");
  if (!text) return null;

  const id =
    firstString(row, "source_id", "id", "external_id") ??
    `hydra:${Buffer.from(text.slice(0, 96)).toString("base64url")}`;
  const title =
    firstString(row, "source_title", "title", "source", "name") ??
    "HydraDB knowledge";
  const sourceUrl = firstString(row, "url", "source_url");

  return { id, title, text, ...(sourceUrl ? { sourceUrl } : {}), metadata };
}

export async function recallHydraKnowledge(
  query: string,
  scope: HydraKnowledgeScope | null,
  log?: { error: (obj: Record<string, unknown>, msg: string) => void },
): Promise<HydraRecallMatch[]> {
  if (!hydraRecallConfigured()) return [];

  const { apiKey, tenantId } = requireHydraConfig();
  const configuredTimeout = Number(process.env["HYDRA_DB_TIMEOUT_MS"] ?? "");
  const timeoutMs =
    Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? Math.min(Math.floor(configuredTimeout), 5000)
      : DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${HYDRA_BASE_URL}/recall/full_recall`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        tenant_id: tenantId,
        query,
        max_results: MAX_HYDRA_MATCHES * 3,
        mode: "fast",
        alpha: 0.7,
        recency_bias: 0.15,
        graph_context: true,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HydraDB recall returned HTTP ${response.status}`);
    }

    const payload = (await response.json()) as HydraRecallResponse;
    const chunks = Array.isArray(payload.chunks) ? payload.chunks : [];
    return chunks
      .map(normalizeMatch)
      .filter((match): match is HydraRecallMatch => Boolean(match))
      .filter((match) => scopeAllowed(match.metadata, scope))
      .slice(0, MAX_HYDRA_MATCHES);
  } catch (error) {
    log?.error({ err: error }, "HydraDB recall failed; using canonical fallback");
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Upload canonical, already-approved Torch knowledge into HydraDB. This helper
 * never decides approval itself; callers must supply only rows that have already
 * cleared Jack's canonical review boundary.
 */
export async function upsertHydraCanonicalKnowledge(
  items: HydraCanonicalKnowledge[],
): Promise<void> {
  if (items.length === 0) return;
  const { apiKey, tenantId } = requireHydraConfig();

  const appKnowledge = items.map((item) => ({
    tenant_id: tenantId,
    sub_tenant_id: item.subTenantId ?? tenantId,
    id: item.id,
    title: item.title,
    type: "torch_living_memory",
    kind: "knowledge",
    provider: "torch",
    external_id: item.id,
    fields: { body: item.body },
    metadata: {
      ...item.metadata,
      torch_approved: true,
      canonical_id: item.id,
    },
  }));

  const form = new FormData();
  form.append("tenant_id", tenantId);
  form.append("upsert", "true");
  form.append("app_knowledge", JSON.stringify(appKnowledge));

  const response = await fetch(`${HYDRA_BASE_URL}/ingestion/upload_knowledge`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!response.ok) {
    throw new Error(`HydraDB upload returned HTTP ${response.status}`);
  }
}
