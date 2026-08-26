import type { KnowledgeGraph } from "./memory-graph.js";

const KNOWLEDGE_KINDS = new Set([
  "concept",
  "tool",
  "equipment",
  "material",
  "procedure",
  "hazard",
  "slang",
  "certification",
  "standard",
  "regional_term",
]);

/**
 * The persisted graph is also the review ledger, so rejected knowledge remains in
 * storage for audit/history. Public Living Memory must never render those nodes
 * (or edges incident to them). Keep the filtering at the API boundary so every
 * frontend consumer gets the same fail-closed view.
 */
export function filterPublicGraph(graph: KnowledgeGraph): KnowledgeGraph {
  const rejectedIds = new Set(
    graph.nodes
      .filter((node) => node.verificationStatus.toLowerCase() === "rejected")
      .map((node) => node.id),
  );

  if (rejectedIds.size === 0) return graph;

  const nodes = graph.nodes.filter((node) => !rejectedIds.has(node.id));
  const liveIds = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter(
    (edge) => liveIds.has(edge.source) && liveIds.has(edge.target),
  );

  return {
    ...graph,
    nodes,
    edges,
    counts: {
      nodes: nodes.length,
      edges: edges.length,
      topics: nodes.filter((node) => node.kind === "topic").length,
      competencies: nodes.filter((node) => node.kind === "competency").length,
      videos: nodes.filter((node) => node.kind === "video").length,
      knowledge: nodes.filter((node) => KNOWLEDGE_KINDS.has(node.kind)).length,
    },
  };
}
