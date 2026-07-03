import { CORE_ID, type ServerGraphNode, type ServerGraphEdge } from "./memory-graph";

/**
 * Synthetic large-graph generator used to exercise the Memory Graph canvas's
 * large-graph fast paths (spatial-grid repulsion, viewport culling, glow LOD)
 * against a realistic node count that the small production data set never
 * reaches on its own. Shared by the dev-only `?graphStress=N` toggle in
 * `useMemoryGraphData` and by `graph-perf.test.ts` so the harness and the
 * regression tests build the exact same shape.
 *
 * Produces a well-formed server graph (same shape as GET /graph) with ~`n`
 * knowledge/video/competency/mentor nodes spread across 10 trade hubs, plus
 * long cross-graph provenance edges that stress the edge-culling path.
 */
export function buildSyntheticServerGraph(n: number): {
  nodes: ServerGraphNode[];
  edges: ServerGraphEdge[];
} {
  const TRADES = [
    "Welder",
    "Electrician",
    "Plumber",
    "Carpenter",
    "Machinist",
    "Millwright",
    "Ironworker",
    "Boilermaker",
    "Steamfitter",
    "Cook",
  ];
  const KINDS = [
    "concept",
    "tool",
    "hazard",
    "procedure",
    "material",
    "equipment",
    "video",
    "competency",
    "mentor",
    "slang",
  ];
  const nodes: ServerGraphNode[] = [
    { id: CORE_ID, kind: "core", label: "JACK" },
  ];
  const edges: ServerGraphEdge[] = [];
  for (const t of TRADES) {
    const id = `topic:${t}`;
    nodes.push({ id, kind: "topic", label: t, trade: t });
    edges.push({ id: `e:${id}`, source: id, target: CORE_ID, kind: "topic" });
  }
  const videoIds: string[] = [];
  for (let i = 0; i < n; i++) {
    const trade = TRADES[i % TRADES.length]!;
    const kind = KINDS[i % KINDS.length]!;
    const id = `${kind}:stress:${i}`;
    if (kind === "video") videoIds.push(id);
    nodes.push({
      id,
      kind,
      label: `${kind} ${i}`,
      trade,
      confidence: (i % 5) / 5,
      verificationStatus: i % 3 === 0 ? "verified" : "unverified",
      meta: { category: kind, sourceCount: (i % 4) + 1 },
    });
    edges.push({
      id: `e:${id}`,
      source: id,
      target: `topic:${trade}`,
      kind: kind === "competency" ? "competency" : "video",
    });
  }
  // Long cross-graph provenance edges between two real video nodes in (usually)
  // different trade clusters, to exercise edge culling when BOTH endpoints can
  // be off-screen at once. Both endpoints are guaranteed to exist.
  for (let i = 0; i + 1 < videoIds.length; i += 7) {
    const a = videoIds[i]!;
    const b = videoIds[(i + Math.floor(videoIds.length / 2)) % videoIds.length]!;
    if (a === b) continue;
    edges.push({ id: `p:${i}`, source: a, target: b, kind: "knowledge" });
  }
  return { nodes, edges };
}
