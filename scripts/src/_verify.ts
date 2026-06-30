import { createClient } from "@supabase/supabase-js";

const url = process.env["SUPABASE_URL"]!;
const key = process.env["SUPABASE_SERVICE_ROLE_KEY"]!;
const supabase = createClient(url, key, { auth: { persistSession: false } });

async function tableOk(name: string, col: string): Promise<string> {
  const { error } = await supabase.from(name).select(col).limit(1);
  if (!error) return "ok";
  if (error.code === "42P01") return "MISSING";
  return `error(${error.code ?? ""}: ${error.message})`;
}

async function fnOk(name: string): Promise<string> {
  const zero = new Array(1536).fill(0);
  const args =
    name === "match_videos"
      ? { query_embedding: zero, match_threshold: 2, match_count: 1 }
      : { query_embedding: zero, match_threshold: 2, match_count: 1 };
  const { error } = await supabase.rpc(name, args);
  if (!error) return "ok";
  return `MISSING/error(${error.code ?? ""}: ${error.message})`;
}

async function main(): Promise<void> {
  console.log("videos:", await tableOk("videos", "id"));
  console.log("transcript_segments:", await tableOk("transcript_segments", "id"));
  console.log("competencies:", await tableOk("competencies", "code"));
  console.log("chat_messages:", await tableOk("chat_messages", "id"));

  const { count } = await supabase
    .from("competencies")
    .select("*", { count: "exact", head: true });
  console.log("competencies_count:", count ?? "n/a");

  console.log("fn match_transcript_segments:", await fnOk("match_transcript_segments"));
  console.log("fn match_videos:", await fnOk("match_videos"));

  const { data: buckets, error: bErr } = await supabase.storage.listBuckets();
  if (bErr) console.log("buckets: error", bErr.message);
  else console.log("bucket jack-videos:", buckets?.some((b) => b.id === "jack-videos") ? "ready" : "MISSING");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
