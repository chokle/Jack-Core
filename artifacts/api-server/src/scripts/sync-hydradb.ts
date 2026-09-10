import { supabase } from "../lib/supabase.js";
import { upsertHydraCanonicalKnowledge } from "../lib/hydradb.js";
import { KNOWLEDGE_NODE_KINDS } from "../lib/memory-graph.js";

const BATCH_SIZE = 50;

async function main(): Promise<void> {
  const { data, error } = await supabase
    .from("knowledge_nodes")
    .select("id, kind, label, description, verification_status, meta")
    .in("kind", [...KNOWLEDGE_NODE_KINDS])
    .eq("verification_status", "verified");

  if (error) throw error;

  const rows = ((data ?? []) as Array<Record<string, unknown>>).filter(
    (row) =>
      typeof row["id"] === "string" &&
      typeof row["label"] === "string" &&
      row["verification_status"] === "verified",
  );

  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const batch = rows.slice(offset, offset + BATCH_SIZE).map((row) => {
      const meta =
        row["meta"] && typeof row["meta"] === "object" && !Array.isArray(row["meta"])
          ? (row["meta"] as Record<string, unknown>)
          : {};
      return {
        id: row["id"] as string,
        title: row["label"] as string,
        body:
          typeof row["description"] === "string" && row["description"]
            ? row["description"]
            : (row["label"] as string),
        metadata: {
          ...meta,
          category: row["kind"],
          verification_status: "verified",
        },
      };
    });
    await upsertHydraCanonicalKnowledge(batch);
  }

  console.log(`HydraDB sync complete: ${rows.length} verified Living Memory nodes.`);
}

main().catch((error) => {
  console.error("HydraDB sync failed", error);
  process.exitCode = 1;
});
