import { createClient } from "@supabase/supabase-js";

/**
 * One-time (idempotent) cleanup for pre-account chat history.
 *
 * Before chat was scoped to signed-in accounts, `chat_messages` rows were
 * saved with only a device `session_id` and no `user_id`. Every live read
 * path now filters strictly by `user_id` (see `routes/chat.ts`), so any row
 * with `user_id IS NULL` is permanently unreachable dead weight.
 *
 * Safe by design:
 *  - Dry-run by default: prints the count and a small sample, deletes nothing.
 *  - Pass `--confirm` to actually delete.
 *  - Deleting `user_id IS NULL` rows twice is a no-op the second time, so
 *    re-running this script (e.g. after new legacy rows appear, which
 *    shouldn't happen post-launch) is always safe.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run cleanup:chat -- --confirm
 */

const supabaseUrl = process.env["SUPABASE_URL"];
const supabaseServiceKey = process.env["SUPABASE_SERVICE_ROLE_KEY"];

if (!supabaseUrl) throw new Error("SUPABASE_URL is required");
if (!supabaseServiceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { persistSession: false },
});

const confirmed = process.argv.includes("--confirm");

async function main(): Promise<void> {
  const { count, error: countError } = await supabase
    .from("chat_messages")
    .select("id", { count: "exact", head: true })
    .is("user_id", null);

  if (countError) {
    throw new Error(`Failed to count legacy chat_messages rows: ${countError.message}`);
  }

  const legacyCount = count ?? 0;

  if (legacyCount === 0) {
    console.log("No legacy chat_messages rows (user_id IS NULL) found. Nothing to clean up.");
    return;
  }

  console.log(`Found ${legacyCount} legacy chat_messages row(s) with user_id IS NULL.`);

  const { data: sample, error: sampleError } = await supabase
    .from("chat_messages")
    .select("id, session_id, role, created_at")
    .is("user_id", null)
    .order("created_at", { ascending: true })
    .limit(5);

  if (sampleError) {
    throw new Error(`Failed to fetch sample legacy rows: ${sampleError.message}`);
  }

  console.log("Sample rows:", sample);

  if (!confirmed) {
    console.log(
      `\nDry run only — no rows deleted. Re-run with --confirm to delete these ${legacyCount} row(s):`,
    );
    console.log("  pnpm --filter @workspace/scripts run cleanup:chat -- --confirm");
    return;
  }

  const { error: deleteError, count: deletedCount } = await supabase
    .from("chat_messages")
    .delete({ count: "exact" })
    .is("user_id", null);

  if (deleteError) {
    throw new Error(`Failed to delete legacy chat_messages rows: ${deleteError.message}`);
  }

  console.log(`Deleted ${deletedCount ?? legacyCount} legacy chat_messages row(s).`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
