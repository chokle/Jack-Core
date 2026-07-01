import { Router } from "express";
import { GetGraphResponse } from "@workspace/api-zod";
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

    // Validate against the generated contract before returning so the persisted
    // graph (including distilled atomic-knowledge nodes/edges) always matches the
    // OpenAPI shape the frontend is generated against.
    return res.json(GetGraphResponse.parse(graph));
  } catch (err) {
    req.log.error({ err }, "getGraph error");
    return res.status(500).json({ error: "Failed to load knowledge graph" });
  }
});

export default router;
