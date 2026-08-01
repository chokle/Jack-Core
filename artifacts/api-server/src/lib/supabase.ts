import { createClient, type SupabaseClient } from "@supabase/supabase-js";

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

export const supabase = new Proxy({}, {
  get(_target, prop, receiver) {
    const client = getSupabase();
    return Reflect.get(client as object, prop, receiver);
  },
}) as SupabaseClient;
