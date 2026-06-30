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
 *
 * Replit is IPv4-only, but Supabase's direct host (db.<ref>.supabase.co) is
 * IPv6-only — so the most common failure here is a cryptic DNS error. This
 * script diagnoses that (and a couple of other copy-paste traps) and tells the
 * user exactly what to fix instead of just dumping SQL.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_PATH = join(__dirname, "supabase-schema.sql");
const sql = readFileSync(SQL_PATH, "utf8");

const dbUrl = process.env["SUPABASE_DB_URL"];

const POOLER_HINT = [
  "Use the Session pooler (IPv4) connection string instead of the direct host.",
  "Find it in: Supabase Dashboard → Project Settings → Database → Connection string → Session pooler (NOT Transaction pooler — DDL needs a session connection).",
  "It looks like:",
  "  postgresql://postgres.<ref>:<password>@aws-<N>-<region>.pooler.supabase.com:5432/postgres",
  "where <N> is 0 or 1 and <ref> is your project ref.",
].join("\n");

/** Pull the project ref out of a direct host like db.<ref>.supabase.co. */
function refFromDirectHost(hostname: string): string | null {
  const match = /^db\.([a-z0-9]+)\.supabase\.co$/i.exec(hostname);
  return match ? (match[1] ?? null) : null;
}

interface UrlInsights {
  hostname: string | null;
  isDirectHost: boolean;
  ref: string | null;
  passwordHasBrackets: boolean;
  /** A copy of the connection string with wrapping [..] removed from the password, if any. */
  sanitized: string;
}

/**
 * Inspect the connection string for the two most common copy-paste traps:
 *  - targeting the IPv6-only direct host (db.<ref>.supabase.co)
 *  - leaving Supabase's [YOUR-PASSWORD] placeholder brackets around the password
 */
function inspectConnectionString(raw: string): UrlInsights {
  const insights: UrlInsights = {
    hostname: null,
    isDirectHost: false,
    ref: null,
    passwordHasBrackets: false,
    sanitized: raw,
  };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return insights;
  }

  insights.hostname = url.hostname;
  const ref = refFromDirectHost(url.hostname);
  if (ref) {
    insights.isDirectHost = true;
    insights.ref = ref;
  }

  let password: string;
  try {
    password = decodeURIComponent(url.password);
  } catch {
    password = url.password;
  }

  if (password.length >= 2 && password.startsWith("[") && password.endsWith("]")) {
    insights.passwordHasBrackets = true;
    url.password = encodeURIComponent(password.slice(1, -1));
    insights.sanitized = url.toString();
  }

  return insights;
}

function printManualInstructions(reason: string): void {
  console.log(`\n${reason}`);
  console.log("\nManual setup — copy the SQL below and run it in:");
  console.log("Supabase Dashboard → SQL Editor → New query → Run\n");
  console.log("----- BEGIN SQL -----");
  console.log(sql);
  console.log("----- END SQL -----\n");
  console.log("This SQL also creates the public 'jack-videos' storage bucket.");
}

/**
 * Turn a raw connection error into actionable setup guidance. Returns the
 * diagnostic text to show the user above the manual-SQL fallback.
 */
function diagnoseConnectionError(err: unknown, insights: UrlInsights): string {
  const message = err instanceof Error ? err.message : String(err);
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? String((err as { code: unknown }).code)
      : "";

  const lines: string[] = [`Automatic apply failed: ${message}`];

  // Wrong password — most often the [...] placeholder or a genuinely bad password.
  if (code === "28P01") {
    lines.push("");
    lines.push("→ The database rejected the password (auth failed).");
    if (insights.passwordHasBrackets) {
      lines.push(
        "  Your password is still wrapped in square brackets ([...]). Those are part of Supabase's [YOUR-PASSWORD] placeholder — remove them and keep only the password itself.",
      );
    } else {
      lines.push(
        "  Reset it in Supabase Dashboard → Project Settings → Database → Reset database password, then update the SUPABASE_DB_URL secret.",
      );
    }
    return lines.join("\n");
  }

  // DNS / IPv6 reachability — the classic Replit ↔ Supabase direct-host failure.
  const isDnsOrIpv6 =
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "EAFNOSUPPORT" ||
    code === "ENETUNREACH" ||
    /ENOTFOUND|EAI_AGAIN|EAFNOSUPPORT|ENETUNREACH/.test(message);

  if (insights.isDirectHost || isDnsOrIpv6) {
    lines.push("");
    if (insights.isDirectHost) {
      lines.push(
        `→ SUPABASE_DB_URL points at the direct host (db.${insights.ref}.supabase.co), which only publishes an IPv6 address. Replit is IPv4-only, so it can't reach it.`,
      );
    } else {
      lines.push(
        "→ Couldn't resolve/reach the database host. This usually means SUPABASE_DB_URL targets the IPv6-only direct host (db.<ref>.supabase.co), which Replit (IPv4-only) can't reach.",
      );
    }
    lines.push("");
    lines.push(POOLER_HINT);
    return lines.join("\n");
  }

  return lines.join("\n");
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

  const insights = inspectConnectionString(dbUrl);

  // Warn up-front about issues we can detect without even connecting.
  if (insights.passwordHasBrackets) {
    console.log(
      "⚠️  Your SUPABASE_DB_URL password is wrapped in square brackets ([...]). Those brackets are part of Supabase's [YOUR-PASSWORD] placeholder, not your password. Stripping them for this run — please update the SUPABASE_DB_URL secret to remove them.\n",
    );
  }
  if (insights.isDirectHost) {
    console.log(
      `⚠️  SUPABASE_DB_URL targets the direct host (db.${insights.ref}.supabase.co), which is IPv6-only and unreachable from Replit (IPv4-only). This will likely fail.\n${POOLER_HINT}\n`,
    );
  }

  try {
    await applyWithConnection(insights.sanitized);
  } catch (err) {
    printManualInstructions(diagnoseConnectionError(err, insights));
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
