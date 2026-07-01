import { Router } from "express";
import {
  GetGraphResponse,
  SetNodeVerificationParams,
  SetNodeVerificationBody,
} from "@workspace/api-zod";
import { getGraph, rebuildGraph, setNodeVerification } from "../lib/memory-graph.js";
import { requireAdminSession } from "../lib/admin-auth.js";

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

// Admin-only review surface: record a human verify/reject/reset decision on a
// distilled concept node. This is the only route that mutates the graph, so it
// is gated behind the same signed admin session used for library management —
// the API uses the Supabase service-role key and has no other auth boundary.
router.patch("/graph/nodes/:id/verification", requireAdminSession, async (req, res) => {
  const paramsParsed = SetNodeVerificationParams.safeParse(req.params);
  if (!paramsParsed.success) return res.status(400).json({ error: "Invalid node id" });

  const bodyParsed = SetNodeVerificationBody.safeParse(req.body);
  if (!bodyParsed.success) return res.status(400).json({ error: bodyParsed.error.message });

  try {
    const node = await setNodeVerification(paramsParsed.data.id, bodyParsed.data.status);
    if (!node) {
      return res.status(404).json({ error: "No distilled knowledge node with that id." });
    }
    return res.json(node);
  } catch (err) {
    req.log.error({ err }, "setNodeVerification error");
    return res.status(500).json({ error: "Failed to update verification status" });
  }
});

export default router;
