import { Router } from "express";
import { supabase } from "../lib/supabase.js";

const router = Router();

// Per-trade counts of non-video Knowledge Entries ("knowledge objects").
// Read-only aggregate; drives the Living Memory branch state/size + the
// dev-only Brain Statistics report. No writes.
router.get("/knowledge/stats", async (req, res) => {
  try {
    const { data: entries, error } = await supabase
      .from("knowledge_entries")
      .select("trade");
    if (error) throw error;

    const byTrade: Record<string, number> = {};
    for (const e of entries ?? []) {
      if (e.trade) byTrade[e.trade] = (byTrade[e.trade] ?? 0) + 1;
    }

    return res.json({ total: entries?.length ?? 0, byTrade });
  } catch (err) {
    req.log.error({ err }, "getKnowledgeStats error");
    return res.status(500).json({ error: "Failed to get knowledge stats" });
  }
});

export default router;
