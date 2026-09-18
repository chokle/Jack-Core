export interface DazRuntimeStatus {
  health: { ok: boolean; schema_version: number; adapter: string; durable_object: boolean };
  state: {
    schema_version: number;
    identity: { id: string; pronouns: string };
    adapter: string;
    generation: number;
    active: boolean;
    receipts: number;
    recoveries: number;
    authority_audit_entries: number;
  };
}

const DEFAULT_TIMEOUT_MS = 2500;

function runtimeUrl(): string | null {
  const value = process.env["DAZ_RUNTIME_URL"]?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.hostname !== "localhost") return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Daz runtime response.");
  return value as Record<string, unknown>;
}

export async function readDazRuntimeStatus(
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
): Promise<DazRuntimeStatus> {
  const base = runtimeUrl();
  if (!base) throw new Error("DAZ_RUNTIME_URL is not configured.");
  const token = process.env["DAZ_RUNTIME_TOKEN"]?.trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const request = async (path: string) => {
      const response = await fetchImpl(`${base}${path}`, {
        headers: token ? { authorization: `Bearer ${token}` } : undefined,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Daz runtime returned HTTP ${response.status}.`);
      return asObject(await response.json());
    };
    const health = await request("/health");
    const stateEnvelope = await request("/state");
    const state = asObject(stateEnvelope["state"]);
    const identity = asObject(state["identity"]);
    const receipts = asObject(state["receipts"]);
    const recoveries = asObject(state["recoveries"]);
    const authorityAudit = state["authority_audit"];
    if (typeof health["ok"] !== "boolean" || typeof state["generation"] !== "number" || typeof identity["id"] !== "string") {
      throw new Error("Daz runtime response is missing required fields.");
    }
    return {
      health: {
        ok: health["ok"],
        schema_version: Number(health["schema_version"]),
        adapter: String(health["adapter"] ?? "unknown"),
        durable_object: Boolean(health["durable_object"]),
      },
      state: {
        schema_version: Number(state["schema_version"]),
        identity: { id: identity["id"], pronouns: String(identity["pronouns"] ?? "") },
        adapter: String(state["adapter"] ?? "unknown"),
        generation: state["generation"],
        active: Boolean(state["active"] ?? false),
        receipts: Object.keys(receipts).length,
        recoveries: Object.keys(recoveries).length,
        authority_audit_entries: Array.isArray(authorityAudit) ? authorityAudit.length : 0,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}
