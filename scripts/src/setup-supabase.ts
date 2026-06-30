import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Jack — Supabase schema setup.
 *
 * Applies the canonical schema in `supabase-schema.sql` to the project's
 * Supabase Postgres database. The Supabase JS/REST client cannot run DDL, so
 * applying the schema requires a direct Postgres connection via SUPABASE_DB_URL.
 *
 * When SUPABASE_DB_URL is configured, the schema is applied automatically (and
 * the run is idempotent). When it is absent or the connection fails, the script
 * prints the raw SQL with instructions to paste it into the Supabase SQL Editor,
 * so manual setup always remains possible.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_PATH = join(__dirname, "supabase-schema.sql");
const sql = readFileSync(SQL_PATH, "utf8");

const dbUrl = process.env["SUPABASE_DB_URL"];

function printManualInstructions(reason: string): void {
  console.log(`\n${reason}`);
  console.log("\nManual setup — copy the SQL below and run it in:");
  console.log("Supabase Dashboard → SQL Editor → New query → Run\n");
  console.log("----- BEGIN SQL -----");
  console.log(sql);
  console.log("----- END SQL -----\n");
  console.log("This SQL also creates the public 'jack-videos' storage bucket.");
}

async function applyWithConnection(connectionString: string): Promise<void> {
  const { default: pg } = await import("pg");
  const client = new pg.Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    console.log("Connected to Supabase Postgres. Applying schema...");
    await client.query(sql);

    const tables = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('videos','transcript_segments','competencies','chat_messages')
       ORDER BY table_name;`,
    );
    const competencies = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM competencies;`,
    );
    const functions = await client.query<{ proname: string }>(
      `SELECT proname FROM pg_proc
       WHERE proname IN ('match_transcript_segments','match_videos')
       ORDER BY proname;`,
    );
    const bucket = await client.query(
      `SELECT id FROM storage.buckets WHERE id = 'jack-videos';`,
    );

    console.log("\n✅ Supabase schema applied successfully.");
    console.log(
      `  Tables:       ${tables.rows.map((r) => r.table_name).join(", ") || "(none)"}`,
    );
    console.log(
      `  Functions:    ${functions.rows.map((r) => r.proname).join(", ") || "(none)"}`,
    );
    console.log(`  Competencies: ${competencies.rows[0]?.n ?? 0} seeded`);
    console.log(
      `  Storage:      'jack-videos' bucket ${bucket.rowCount ? "ready" : "MISSING"}`,
    );
  } finally {
    await client.end();
  }
}

async function run(): Promise<void> {
  console.log("Jack — Supabase schema setup\n");

  if (!dbUrl) {
    printManualInstructions(
      "SUPABASE_DB_URL is not set, so the schema cannot be applied automatically.",
    );
    return;
  }

  try {
    await applyWithConnection(dbUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    printManualInstructions(`Automatic apply failed: ${message}`);
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
