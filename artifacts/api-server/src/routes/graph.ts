import { Router } from "express";
import { getGraph, rebuildGraph } from "../lib/memory-graph.js";

const router = Router();

router.get("/graph", async (req, res) => {
  try {
    let graph = await getGraph();

    // Self-heal: an empty graph means the persisted mirror hasn't been built yet
    // (fresh DB, or videos ingested before this feature existed). Rebuild it from
    // the source tables — deterministic, idempotent, and free (no AI calls). We
    // deliberately do NOT expose a public rebuild endpoint: this API holds the
    // Supabase service-role key and has no auth, so an unauthenticated mutating
    // maintenance route would be an abuse vector. Rebuild stays server-internal.
    if (graph.nodes.length === 0) {
      await rebuildGraph();
      graph = await getGraph();
    }

    return res.json(graph);
  } catch (err) {
    req.log.error({ err }, "getGraph error");
    return res.status(500).json({ error: "Failed to load knowledge graph" });
  }
});

export default router;
