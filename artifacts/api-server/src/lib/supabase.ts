import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { recallHydraKnowledge } from "./hydradb.js";
import { sourceTextForEmbedding } from "./openai.js";

const supabaseUrl = process.env["SUPABASE_URL"];
const supabaseServiceKey = process.env["SUPABASE_SERVICE_ROLE_KEY"];

function ensureSupabaseConfig(): readonly [string, string] {
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for database-backed routes.",
    );
  }

  return [supabaseUrl, supabaseServiceKey];
}

let cachedSupabase: SupabaseClient | null = null;

const getSupabase = (): SupabaseClient => {
  if (!cachedSupabase) {
    const [url, serviceKey] = ensureSupabaseConfig();
    cachedSupabase = createClient(url, serviceKey, {
      auth: { persistSession: false },
    });
  }

  return cachedSupabase;
};

async function hydraKnowledgeNodeRpc(
  client: SupabaseClient,
  fn: string,
  args: Record<string, unknown> | undefined,
  options: Record<string, unknown> | undefined,
) {
  if (fn !== "match_knowledge_nodes" || !args) {
    return client.rpc(fn, args, options);
  }

  const query = sourceTextForEmbedding(args["query_embedding"]);
  if (!query) return client.rpc(fn, args, options);

  const matches = await recallHydraKnowledge(query, null);
  if (matches.length === 0) return client.rpc(fn, args, options);

  // HydraDB only selects/ranks canonical node IDs here. chat.ts immediately
  // fetches the actual rows back from Supabase, so Supabase remains the source
  // of truth for content, verification state, and provenance.
  const data = matches.map((match, index) => {
    const canonicalId =
      typeof match.metadata["canonical_id"] === "string" &&
      match.metadata["canonical_id"]
        ? (match.metadata["canonical_id"] as string)
        : match.id;
    return {
      id: canonicalId,
      similarity: Math.max(0.5, 1 - index * 0.05),
    };
  });

  return { data, error: null, count: null, status: 200, statusText: "OK" };
}

export const supabase = new Proxy({}, {
  get(_target, prop, receiver) {
    const client = getSupabase();
    if (prop === "rpc") {
      return (
        fn: string,
        args?: Record<string, unknown>,
        options?: Record<string, unknown>,
      ) => hydraKnowledgeNodeRpc(client, fn, args, options);
    }
    return Reflect.get(client as object, prop, receiver);
  },
}) as SupabaseClient;
