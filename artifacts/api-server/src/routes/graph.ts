import { Router } from "express";
import {
  GetGraphResponse,
  ListKnowledgeCandidatesQueryParams,
  ListKnowledgeCandidatesResponse,
  ResolveKnowledgeCandidateParams,
  ResolveKnowledgeCandidateBody,
  ResolveKnowledgeCandidateResponse,
  SetNodeVerificationParams,
  SetNodeVerificationBody,
} from "@workspace/api-zod";
import {
  getGraph,
  rebuildGraph,
  setNodeVerification,
  listKnowledgeCandidates,
  resolveKnowledgeCandidate,
} from "../lib/memory-graph.js";
import { requireAdminSession, isAdminSessionValid } from "../lib/admin-auth.js";

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

// List of mentor-concept candidates queued for review — uncertain mentor
// knowledge held OUTSIDE the live graph so it is never lost. Pending items are
// publicly readable: anyone browsing the Living Memory can see what knowledge
// is awaiting Knowledge Review, so mentors trust queued concepts aren't lost.
// Non-pending statuses carry resolution details (rejection reasons, merge
// targets) and stay behind the same admin boundary as the resolve route.
router.get("/graph/candidates", async (req, res) => {
  const parsed = ListKnowledgeCandidatesQueryParams.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Invalid status filter" });

  if (parsed.data.status !== "pending" && !isAdminSessionValid(req)) {
    req.log.warn(
      { url: req.url, status: parsed.data.status },
      "non-pending candidate list requires admin session",
    );
    return res.status(401).json({ error: "Unauthorized — admin session required." });
  }

  try {
    const candidates = await listKnowledgeCandidates(parsed.data.status);
    return res.json(
      ListKnowledgeCandidatesResponse.parse({ candidates, total: candidates.length }),
    );
  } catch (err) {
    req.log.error({ err }, "listKnowledgeCandidates error");
    return res.status(500).json({ error: "Failed to load knowledge candidates" });
  }
});

// Knowledge Review write path: resolve a pending candidate as Accept (reinforce
// its top best match), Merge (reinforce a reviewer-chosen concept), or Reject
// (record a required reason; graph untouched). Admin-gated like node
// verification — this mutates the shared Living Memory graph.
router.post("/graph/candidates/:id/resolve", requireAdminSession, async (req, res) => {
  const paramsParsed = ResolveKnowledgeCandidateParams.safeParse(req.params);
  if (!paramsParsed.success) return res.status(400).json({ error: "Invalid candidate id" });

  const bodyParsed = ResolveKnowledgeCandidateBody.safeParse(req.body);
  if (!bodyParsed.success) return res.status(400).json({ error: bodyParsed.error.message });

  try {
    const result = await resolveKnowledgeCandidate(paramsParsed.data.id, bodyParsed.data.action, {
      targetNodeId: bodyParsed.data.targetNodeId ?? null,
      reason: bodyParsed.data.reason ?? null,
    });
    if (!result.ok) {
      const status =
        result.code === "not_found" ? 404 : result.code === "conflict" ? 409 : 400;
      return res.status(status).json({ error: result.message });
    }
    return res.json(ResolveKnowledgeCandidateResponse.parse(result.candidate));
  } catch (err) {
    req.log.error({ err }, "resolveKnowledgeCandidate error");
    return res.status(500).json({ error: "Failed to resolve knowledge candidate" });
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
