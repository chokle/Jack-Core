/**
 * memory-graph — server-side persistence for Jack's "Living Memory" graph.
 *
 * The graph is a persisted mirror of what Jack knows: a central core, one topic
 * hub per trade, the seeded Red Seal competencies, and one node per ingested
 * video. Node/edge IDs are deterministic, so every write is an idempotent
 * upsert — re-processing or "merging" knowledge collapses onto the same node
 * instead of duplicating it. The frontend renders whatever this returns.
 *
 * Supabase JS cannot run inside a single transaction here, so writes are ordered
 * (nodes before edges) and video edges are reconciled by delete-then-reinsert.
 * A brief poll-visible inconsistency is acceptable for a derived view.
 */
import { supabase } from "./supabase.js";

export const GRAPH_CORE_ID = "__jack__";

const topicNodeId = (trade: string) => `topic:${trade}`;
const compNodeId = (code: string) => `comp:${code}`;
const videoNodeId = (id: string) => `video:${id}`;
const edgeKey = (source: string, target: string) => `e:${source}->${target}`;

export interface GraphNode {
  id: string;
  kind: "core" | "topic" | "competency" | "video";
  label: string;
  trade: string | null;
  refId: string | null;
  meta: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: string;
  weight: number;
}

export interface KnowledgeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  counts: {
    nodes: number;
    edges: number;
    topics: number;
    competencies: number;
    videos: number;
  };
  generatedAt: string;
}

interface NodeUpsert {
  id: string;
  kind: string;
  label: string;
  trade?: string | null;
  ref_id?: string | null;
  meta?: Record<string, unknown>;
}

interface EdgeUpsert {
  id: string;
  source_id: string;
  target_id: string;
  kind: string;
}

async function upsertNodes(nodes: NodeUpsert[]): Promise<void> {
  if (nodes.length === 0) return;
  const now = new Date().toISOString();
  const rows = nodes.map((n) => ({
    id: n.id,
    kind: n.kind,
    label: n.label,
    trade: n.trade ?? null,
    ref_id: n.ref_id ?? null,
    meta: n.meta ?? {},
    updated_at: now,
  }));
  const { error } = await supabase.from("knowledge_nodes").upsert(rows, { onConflict: "id" });
  if (error) throw error;
}

/**
 * Fill in competency nodes referenced by a video without clobbering the richer
 * seeded rows — ignoreDuplicates means an already-seeded competency keeps its
 * name/trade/description, while an unseeded code still gets a minimal node so
 * the video→competency edge never violates the foreign key.
 */
async function ensureCompetencyNodes(codes: string[]): Promise<void> {
  if (codes.length === 0) return;
  const rows = codes.map((code) => ({
    id: compNodeId(code),
    kind: "competency",
    label: code,
    ref_id: code,
    meta: { code },
  }));
  const { error } = await supabase
    .from("knowledge_nodes")
    .upsert(rows, { onConflict: "id", ignoreDuplicates: true });
  if (error) throw error;
}

async function upsertEdges(edges: EdgeUpsert[]): Promise<void> {
  if (edges.length === 0) return;
  const { error } = await supabase.from("knowledge_edges").upsert(edges, { onConflict: "id" });
  if (error) throw error;
}

/**
 * Ensure the core, one topic hub per trade, every seeded competency, and their
 * scaffold edges exist. Idempotent; safe to call anytime.
 */
export async function ensureBaseGraph(): Promise<void> {
  const { data: comps, error } = await supabase
    .from("competencies")
    .select("code, name, trade, description");
  if (error) throw error;

  const competencies = (comps ?? []) as Array<Record<string, string | null>>;
  const trades = [
    ...new Set(competencies.map((c) => c["trade"]).filter((t): t is string => !!t)),
  ];

  const nodes: NodeUpsert[] = [{ id: GRAPH_CORE_ID, kind: "core", label: "JACK" }];
  const edges: EdgeUpsert[] = [];

  for (const trade of trades) {
    nodes.push({ id: topicNodeId(trade), kind: "topic", label: trade, trade });
    edges.push({
      id: edgeKey(GRAPH_CORE_ID, topicNodeId(trade)),
      source_id: GRAPH_CORE_ID,
      target_id: topicNodeId(trade),
      kind: "topic",
    });
  }

  for (const c of competencies) {
    const code = c["code"];
    const trade = c["trade"];
    if (!code || !trade) continue;
    nodes.push({
      id: compNodeId(code),
      kind: "competency",
      label: code,
      trade,
      ref_id: code,
      meta: { code, trade, description: c["description"] ?? c["name"] ?? undefined },
    });
    edges.push({
      id: edgeKey(topicNodeId(trade), compNodeId(code)),
      source_id: topicNodeId(trade),
      target_id: compNodeId(code),
      kind: "competency",
    });
  }

  await upsertNodes(nodes);
  await upsertEdges(edges);
}

/**
 * Write a single video's node and reconcile its edges (topic hub, video, and
 * competency links) so re-analysis, a trade change, or a shorter competency list
 * can never leave stale relationships behind. If the video no longer exists
 * (deleted between enqueue and run) its node is removed. Internal: callers go
 * through syncVideoGraph, which also prunes any topic left orphaned by a re-home.
 */
async function writeVideoNode(videoId: string): Promise<void> {
  const { data: video, error } = await supabase
    .from("videos")
    .select("id, title, trade, status, description, competency_codes, created_at, updated_at")
    .eq("id", videoId)
    .maybeSingle();
  if (error) throw error;

  if (!video) {
    await deleteVideoNode(videoId);
    return;
  }

  const v = video as Record<string, unknown>;
  const trade = (v["trade"] as string | null) ?? null;
  const codes = Array.isArray(v["competency_codes"])
    ? (v["competency_codes"] as unknown[]).filter((c): c is string => typeof c === "string")
    : [];
  const vNode = videoNodeId(videoId);

  const nodes: NodeUpsert[] = [{ id: GRAPH_CORE_ID, kind: "core", label: "JACK" }];
  const scaffoldEdges: EdgeUpsert[] = [];

  if (trade) {
    nodes.push({ id: topicNodeId(trade), kind: "topic", label: trade, trade });
    scaffoldEdges.push({
      id: edgeKey(GRAPH_CORE_ID, topicNodeId(trade)),
      source_id: GRAPH_CORE_ID,
      target_id: topicNodeId(trade),
      kind: "topic",
    });
  }

  nodes.push({
    id: vNode,
    kind: "video",
    label: (v["title"] as string) ?? "Untitled",
    trade,
    ref_id: videoId,
    meta: {
      status: v["status"] ?? null,
      trade: trade ?? undefined,
      description: v["description"] ?? undefined,
      competencyCodes: codes,
      createdAt: v["created_at"] ?? undefined,
      updatedAt: v["updated_at"] ?? v["created_at"] ?? undefined,
    },
  });

  await upsertNodes(nodes);
  await ensureCompetencyNodes(codes);

  // Reconcile: remove every edge incident to this video node, then re-add the
  // authoritative set. Two scoped deletes avoid building a raw `.or()` filter
  // string from the node id.
  const del1 = await supabase.from("knowledge_edges").delete().eq("source_id", vNode);
  if (del1.error) throw del1.error;
  const del2 = await supabase.from("knowledge_edges").delete().eq("target_id", vNode);
  if (del2.error) throw del2.error;

  const parent = trade ? topicNodeId(trade) : GRAPH_CORE_ID;
  const edges: EdgeUpsert[] = [
    ...scaffoldEdges,
    { id: edgeKey(parent, vNode), source_id: parent, target_id: vNode, kind: "video" },
    ...codes.map((code) => ({
      id: edgeKey(vNode, compNodeId(code)),
      source_id: vNode,
      target_id: compNodeId(code),
      kind: "competency",
    })),
  ];
  await upsertEdges(edges);
}

/** Remove a video's node; its edges cascade via the foreign key. Internal. */
async function deleteVideoNode(videoId: string): Promise<void> {
  const { error } = await supabase
    .from("knowledge_nodes")
    .delete()
    .eq("id", videoNodeId(videoId));
  if (error) throw error;
}

/**
 * Remove topic hubs no longer backed by source data. A topic is kept only if its
 * trade belongs to a seeded competency or is still referenced by at least one
 * video; everything else (a freeform trade whose last video was deleted or
 * re-homed to another trade) is pruned. Its scaffold edge to the core cascades
 * away with it, so the persisted graph never drifts from the source tables.
 */
async function pruneOrphanTopics(): Promise<void> {
  const [comps, vids, topics] = await Promise.all([
    supabase.from("competencies").select("trade"),
    supabase.from("videos").select("trade"),
    supabase.from("knowledge_nodes").select("id, trade").eq("kind", "topic"),
  ]);
  if (comps.error) throw comps.error;
  if (vids.error) throw vids.error;
  if (topics.error) throw topics.error;

  const keep = new Set<string>();
  for (const r of [...(comps.data ?? []), ...(vids.data ?? [])]) {
    const t = (r as Record<string, unknown>)["trade"];
    if (typeof t === "string" && t) keep.add(t);
  }

  const orphanIds = (topics.data ?? [])
    .map((r: Record<string, unknown>) => ({
      id: r["id"] as string,
      trade: (r["trade"] as string | null) ?? null,
    }))
    .filter((n) => !n.trade || !keep.has(n.trade))
    .map((n) => n.id);

  if (orphanIds.length > 0) {
    const { error } = await supabase.from("knowledge_nodes").delete().in("id", orphanIds);
    if (error) throw error;
  }
}

/**
 * Mirror a single video into the graph, then prune any topic left orphaned when
 * a video changed trade. Best-effort callers (syncGraphSafe) swallow failures.
 */
export async function syncVideoGraph(videoId: string): Promise<void> {
  await writeVideoNode(videoId);
  await pruneOrphanTopics();
}

/** Remove a video's node and prune any topic its removal left orphaned. */
export async function removeVideoGraph(videoId: string): Promise<void> {
  await deleteVideoNode(videoId);
  await pruneOrphanTopics();
}

/**
 * Rebuild the whole graph from the source tables: base scaffold, one sync per
 * existing video, then prune video nodes whose source video is gone. Used to
 * self-heal an empty/partial graph (e.g. a DB seeded before this feature).
 */
export async function rebuildGraph(): Promise<void> {
  await ensureBaseGraph();

  const { data: videos, error } = await supabase.from("videos").select("id");
  if (error) throw error;
  const ids = (videos ?? []).map((r: Record<string, unknown>) => r["id"] as string);
  for (const id of ids) {
    await writeVideoNode(id);
  }

  const { data: vNodes, error: nErr } = await supabase
    .from("knowledge_nodes")
    .select("id, ref_id")
    .eq("kind", "video");
  if (nErr) throw nErr;

  const live = new Set(ids);
  const stale = (vNodes ?? [])
    .map((r: Record<string, unknown>) => ({
      id: r["id"] as string,
      refId: (r["ref_id"] as string | null) ?? null,
    }))
    .filter((r) => !r.refId || !live.has(r.refId))
    .map((r) => r.id);

  if (stale.length > 0) {
    const { error: dErr } = await supabase.from("knowledge_nodes").delete().in("id", stale);
    if (dErr) throw dErr;
  }

  await pruneOrphanTopics();
}

/** Read the full persisted graph. */
export async function getGraph(): Promise<KnowledgeGraph> {
  const [{ data: nodeRows, error: nErr }, { data: edgeRows, error: eErr }] = await Promise.all([
    supabase.from("knowledge_nodes").select("*"),
    supabase.from("knowledge_edges").select("*"),
  ]);
  if (nErr) throw nErr;
  if (eErr) throw eErr;

  const nodes: GraphNode[] = (nodeRows ?? []).map((r: Record<string, unknown>) => ({
    id: r["id"] as string,
    kind: r["kind"] as GraphNode["kind"],
    label: r["label"] as string,
    trade: (r["trade"] as string | null) ?? null,
    refId: (r["ref_id"] as string | null) ?? null,
    meta: (r["meta"] as Record<string, unknown>) ?? {},
    createdAt: r["created_at"] as string,
    updatedAt: (r["updated_at"] as string) ?? (r["created_at"] as string),
  }));

  const edges: GraphEdge[] = (edgeRows ?? []).map((r: Record<string, unknown>) => ({
    id: r["id"] as string,
    source: r["source_id"] as string,
    target: r["target_id"] as string,
    kind: r["kind"] as string,
    weight: (r["weight"] as number) ?? 1,
  }));

  return {
    nodes,
    edges,
    counts: {
      nodes: nodes.length,
      edges: edges.length,
      topics: nodes.filter((n) => n.kind === "topic").length,
      competencies: nodes.filter((n) => n.kind === "competency").length,
      videos: nodes.filter((n) => n.kind === "video").length,
    },
    generatedAt: new Date().toISOString(),
  };
}
