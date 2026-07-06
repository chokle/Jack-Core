import { Router } from "express";
import {
  GetGraphResponse,
  GetGraphHealthResponse,
  ListKnowledgeCandidatesQueryParams,
  ListKnowledgeCandidatesResponse,
  GetMentorContributionsResponse,
  ResolveKnowledgeCandidateParams,
  ResolveKnowledgeCandidateBody,
  ResolveKnowledgeCandidateResponse,
  SetNodeVerificationParams,
  SetNodeVerificationBody,
  RestoreWithdrawnEvidenceParams,
  RestoreWithdrawnEvidenceBody,
} from "@workspace/api-zod";
import {
  getGraph,
  rebuildGraph,
  setNodeVerification,
  restoreWithdrawnEvidence,
  listKnowledgeCandidates,
  getMentorContributionStats,
  resolveKnowledgeCandidate,
  getGraphHealth,
} from "../lib/memory-graph.js";
import {
  requireAdmin,
  resolveAdminIdentity,
  getAdminReviewer,
} from "../lib/admin-auth.js";

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

  if (parsed.data.status !== "pending" && !(await resolveAdminIdentity(req))) {
    req.log.warn(
      { url: req.url, status: parsed.data.status },
      "non-pending candidate list requires admin access",
    );
    return res.status(403).json({ error: "Forbidden — admin access required." });
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

// Per-mentor contribution counts — a read-only track record (concepts created /
// reinforced in the live graph, plus accepted / rejected / pending candidates)
// that reviewers use to calibrate trust in a borderline candidate. Admin-gated
// like the resolved-candidate surface: it correlates mentor identities with
// their whole contribution history, which the public product never exposes.
router.get("/graph/mentor-contributions", requireAdmin, async (req, res) => {
  try {
    const contributions = await getMentorContributionStats();
    return res.json(
      GetMentorContributionsResponse.parse({ contributions, total: contributions.length }),
    );
  } catch (err) {
    req.log.error({ err }, "getMentorContributions error");
    return res.status(500).json({ error: "Failed to load mentor contributions" });
  }
});

// Knowledge Review write path: resolve a pending candidate as Accept (reinforce
// its top best match), Merge (reinforce a reviewer-chosen concept), or Reject
// (record a required reason; graph untouched). Admin-gated like node
// verification — this mutates the shared Living Memory graph.
router.post("/graph/candidates/:id/resolve", requireAdmin, async (req, res) => {
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
      // target_gone is a STRUCTURED conflict: the candidate stays pending and
      // the body carries fresh near matches so the reviewer can re-aim.
      if (result.code === "target_gone") {
        return res.status(409).json({
          error: result.message,
          code: "target_gone",
          bestMatches: result.bestMatches,
        });
      }
      const status =
        result.code === "not_found" ? 404 : result.code === "conflict" ? 409 : 400;
      return res.status(status).json({
        error: result.message,
        ...(result.code === "conflict" ? { code: "already_resolved" } : {}),
      });
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
router.patch("/graph/nodes/:id/verification", requireAdmin, async (req, res) => {
  const paramsParsed = SetNodeVerificationParams.safeParse(req.params);
  if (!paramsParsed.success) return res.status(400).json({ error: "Invalid node id" });

  const bodyParsed = SetNodeVerificationBody.safeParse(req.body);
  if (!bodyParsed.success) return res.status(400).json({ error: bodyParsed.error.message });

  try {
    // Attribute the decision to the signed-in reviewer carried in the session
    // cookie — never a client-supplied field — so the recorded identity cannot
    // be spoofed by the request body.
    const node = await setNodeVerification(
      paramsParsed.data.id,
      bodyParsed.data.status,
      getAdminReviewer(req),
    );
    if (!node) {
      return res.status(404).json({ error: "No distilled knowledge node with that id." });
    }
    return res.json(node);
  } catch (err) {
    req.log.error({ err }, "setNodeVerification error");
    return res.status(500).json({ error: "Failed to update verification status" });
  }
});

// Admin-only: clear a reviewed withdrawn-evidence entry from a concept's
// provenance. Gated identically to node verification — this mutates the shared
// Living Memory graph and the API holds the Supabase service-role key with no
// other auth boundary. Idempotent: a missing entry returns the node unchanged.
router.post("/graph/nodes/:id/restore-evidence", requireAdmin, async (req, res) => {
  const paramsParsed = RestoreWithdrawnEvidenceParams.safeParse(req.params);
  if (!paramsParsed.success) return res.status(400).json({ error: "Invalid node id" });

  const bodyParsed = RestoreWithdrawnEvidenceBody.safeParse(req.body);
  if (!bodyParsed.success) return res.status(400).json({ error: bodyParsed.error.message });

  try {
    const node = await restoreWithdrawnEvidence(paramsParsed.data.id, bodyParsed.data.videoId);
    if (!node) {
      return res.status(404).json({ error: "No distilled knowledge node with that id." });
    }
    return res.json(node);
  } catch (err) {
    req.log.error({ err }, "restoreWithdrawnEvidence error");
    return res.status(500).json({ error: "Failed to restore withdrawn evidence" });
  }
});

// Admin-only Graph Health dashboard: knowledge-write verification counts
// (verified/partial/failed), the retry queue (videos + answers awaiting a
// retry), average processing time, and the most recent writes with per-check
// detail. Gated behind the signed admin session — it exposes internal write
// telemetry and the API holds the Supabase service-role key.
router.get("/graph/health", requireAdmin, async (req, res) => {
  try {
    const report = await getGraphHealth();
    return res.json(GetGraphHealthResponse.parse(report));
  } catch (err) {
    req.log.error({ err }, "getGraphHealth error");
    return res.status(500).json({ error: "Failed to load graph health" });
  }
});

export default router;
