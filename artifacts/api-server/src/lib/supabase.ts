import { createClient } from "@supabase/supabase-js";

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

function createSystemClient(url: string, serviceKey: string) {
  // Explicit `any` preserves the intentionally untyped legacy database client.
  // `ReturnType<typeof createClient>` on the generic factory collapses table
  // operations to `never` under TypeScript 5.9.
  return createClient<any>(url, serviceKey, {
    auth: { persistSession: false },
  });
}

type SystemSupabaseClient = ReturnType<typeof createSystemClient>;
let cachedSupabase: SystemSupabaseClient | null = null;

const getSupabase = (): SystemSupabaseClient => {
  if (!cachedSupabase) {
    const [url, serviceKey] = ensureSupabaseConfig();
    cachedSupabase = createSystemClient(url, serviceKey);
  }

  return cachedSupabase;
};

export const supabase = new Proxy({}, {
  get(_target, prop, receiver) {
    const client = getSupabase();
    return Reflect.get(client as object, prop, receiver);
  },
}) as SystemSupabaseClient;
