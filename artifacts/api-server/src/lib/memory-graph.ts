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
import type { AtomicKnowledge, KnowledgeCategory } from "./distillation.js";

export const GRAPH_CORE_ID = "__jack__";

const topicNodeId = (trade: string) => `topic:${trade}`;
const compNodeId = (code: string) => `comp:${code}`;
const videoNodeId = (id: string) => `video:${id}`;
const edgeKey = (source: string, target: string) => `e:${source}->${target}`;

/**
 * Normalize a free-text concept name into a stable slug so the same concept
 * (regardless of casing, punctuation, or surrounding whitespace) always maps to
 * the same canonical id. This guarantees exact/normalized reuse across videos —
 * fuzzy/semantic dedup of differently-worded concepts is the Graph Intelligence
 * task, not this one.
 */
export function normalizeConcept(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Canonical, deterministic id for an atomic knowledge node: the same concept
 * name + category always yields the same id, so re-extracting it (from this or
 * any other video) upserts the one shared node instead of duplicating it.
 */
export function knowledgeNodeId(category: KnowledgeCategory, title: string): string {
  return `k:${category}:${normalizeConcept(title)}`;
}

/** Atomic knowledge categories — the node kinds distilled from transcripts. */
export const KNOWLEDGE_NODE_KINDS = [
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
] as const;

export type KnowledgeNodeKind = (typeof KNOWLEDGE_NODE_KINDS)[number];

export interface GraphNode {
  id: string;
  kind: "core" | "topic" | "competency" | "video" | KnowledgeNodeKind;
  label: string;
  trade: string | null;
  refId: string | null;
  description: string | null;
  confidence: number | null;
  verificationStatus: string;
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
  meta: Record<string, unknown>;
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
    knowledge: number;
  };
  generatedAt: string;
}

interface NodeUpsert {
  id: string;
  kind: string;
  label: string;
  trade?: string | null;
  ref_id?: string | null;
  description?: string | null;
  confidence?: number | null;
  verification_status?: string;
  meta?: Record<string, unknown>;
}

interface EdgeUpsert {
  id: string;
  source_id: string;
  target_id: string;
  kind: string;
  meta?: Record<string, unknown>;
}

async function upsertNodes(nodes: NodeUpsert[]): Promise<void> {
  if (nodes.length === 0) return;
  const now = new Date().toISOString();
  // Only include the atomic-knowledge columns when a caller provides them, so
  // upserting a scaffold node (core/topic/competency/video) never clobbers an
  // atomic node's description/confidence/verification_status on conflict.
  const rows = nodes.map((n) => {
    const row: Record<string, unknown> = {
      id: n.id,
      kind: n.kind,
      label: n.label,
      trade: n.trade ?? null,
      ref_id: n.ref_id ?? null,
      meta: n.meta ?? {},
      updated_at: now,
    };
    if (n.description !== undefined) row["description"] = n.description;
    if (n.confidence !== undefined) row["confidence"] = n.confidence;
    if (n.verification_status !== undefined) row["verification_status"] = n.verification_status;
    return row;
  });
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
  const rows = edges.map((e) => {
    const row: Record<string, unknown> = {
      id: e.id,
      source_id: e.source_id,
      target_id: e.target_id,
      kind: e.kind,
    };
    if (e.meta !== undefined) row["meta"] = e.meta;
    return row;
  });
  const { error } = await supabase.from("knowledge_edges").upsert(rows, { onConflict: "id" });
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

  // Reconcile the structural edges incident to this video node, then re-add the
  // authoritative set. Two scoped deletes avoid building a raw `.or()` filter
  // string from the node id. Crucially, the source_id delete EXCLUDES kind
  // 'knowledge': those video→knowledge provenance edges are owned by the
  // distillation engine (syncVideoKnowledge) and must survive a plain re-sync
  // (e.g. a metadata edit) that does not re-run distillation.
  const del1 = await supabase
    .from("knowledge_edges")
    .delete()
    .eq("source_id", vNode)
    .neq("kind", "knowledge");
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
 * Remove atomic knowledge nodes that no longer have a single source video (no
 * incoming video→knowledge edge). A concept only exists because some video
 * taught it; once its last provenance edge is gone (video deleted or a
 * re-processing no longer distills it), an empty-provenance node is meaningless,
 * so it is pruned. Its knowledge→topic / knowledge→competency edges cascade away.
 * Scaffold nodes (core/topic/competency/video) are never touched here.
 */
async function pruneOrphanKnowledge(): Promise<void> {
  const [nodes, edges] = await Promise.all([
    supabase.from("knowledge_nodes").select("id, kind").in("kind", [...KNOWLEDGE_NODE_KINDS]),
    supabase.from("knowledge_edges").select("target_id").eq("kind", "knowledge"),
  ]);
  if (nodes.error) throw nodes.error;
  if (edges.error) throw edges.error;

  const sourced = new Set<string>();
  for (const e of edges.data ?? []) {
    const t = (e as Record<string, unknown>)["target_id"];
    if (typeof t === "string") sourced.add(t);
  }

  const orphanIds = (nodes.data ?? [])
    .map((r: Record<string, unknown>) => r["id"] as string)
    .filter((id) => !sourced.has(id));

  if (orphanIds.length > 0) {
    const { error } = await supabase.from("knowledge_nodes").delete().in("id", orphanIds);
    if (error) throw error;
  }
}

/**
 * Distill a video's atomic knowledge into the graph. For each reusable concept,
 * upsert the shared canonical node (merging with any prior extraction rather than
 * clobbering it), then reconcile ONLY this video's provenance edges — so the
 * concept's source-video list grows across videos and re-processing never
 * duplicates or drops another video's contribution. Knowledge→topic and
 * knowledge→competency edges are additive (a growing many-to-many); orphaned
 * concepts (no remaining source video) are pruned at the end.
 *
 * Internal to the pipeline: there is no public route that mutates the graph.
 */
export async function syncVideoKnowledge(
  videoId: string,
  items: AtomicKnowledge[],
): Promise<void> {
  const vNode = videoNodeId(videoId);

  const { data: video, error: vErr } = await supabase
    .from("videos")
    .select("trade")
    .eq("id", videoId)
    .maybeSingle();
  if (vErr) throw vErr;
  // If the video vanished between distillation and persistence, clear any stale
  // provenance it left behind and stop.
  if (!video) {
    await supabase.from("knowledge_edges").delete().eq("source_id", vNode).eq("kind", "knowledge");
    await pruneOrphanKnowledge();
    return;
  }
  const trade = (video.trade as string | null) ?? null;

  const ids = items.map((i) => i.id);
  const existingById = new Map<string, Record<string, unknown>>();
  if (ids.length > 0) {
    const { data: rows, error } = await supabase
      .from("knowledge_nodes")
      .select("id, label, trade, description, confidence, verification_status")
      .in("id", ids);
    if (error) throw error;
    for (const r of rows ?? []) existingById.set((r as Record<string, unknown>)["id"] as string, r);
  }

  const nodes: NodeUpsert[] = items.map((item) => {
    const prev = existingById.get(item.id);
    const prevStatus = prev?.["verification_status"] as string | undefined;
    const prevConfidence =
      typeof prev?.["confidence"] === "number" ? (prev["confidence"] as number) : null;
    return {
      id: item.id,
      kind: item.category,
      // First writer wins for the display label/trade so the shared node stays
      // stable; later videos still append provenance via the edge.
      label: (prev?.["label"] as string) || item.title,
      trade: (prev?.["trade"] as string | null) ?? trade,
      ref_id: item.id,
      description: item.description || ((prev?.["description"] as string | null) ?? null),
      // Sensible monotonic init only — corroboration-based recomputation is the
      // Graph Intelligence task's job, not this one.
      confidence: Math.max(prevConfidence ?? 0, item.confidence),
      // Preserve a human verification decision; default new nodes to unverified.
      verification_status:
        prevStatus === "verified" || prevStatus === "rejected" ? prevStatus : "unverified",
      meta: { category: item.category },
    };
  });

  // Ensure competency nodes exist for any mapped codes (never clobber seeded rows).
  const codes = [...new Set(items.map((i) => i.competencyCode).filter((c): c is string => !!c))];
  await ensureCompetencyNodes(codes);
  await upsertNodes(nodes);

  // Reconcile only this video's provenance edges: drop the old set, add the new.
  const del = await supabase
    .from("knowledge_edges")
    .delete()
    .eq("source_id", vNode)
    .eq("kind", "knowledge");
  if (del.error) throw del.error;

  const provenanceEdges: EdgeUpsert[] = items.map((item) => ({
    id: edgeKey(vNode, item.id),
    source_id: vNode,
    target_id: item.id,
    kind: "knowledge",
    meta: { timestamps: item.timestamps, confidence: item.confidence },
  }));

  // Additive hub edges: connect each concept to its trade topic and any mapped
  // competency. These accumulate across videos (a growing many-to-many web).
  const hubEdges: EdgeUpsert[] = [];
  for (const item of items) {
    if (trade) {
      hubEdges.push({
        id: edgeKey(item.id, topicNodeId(trade)),
        source_id: item.id,
        target_id: topicNodeId(trade),
        kind: "topic",
      });
    }
    if (item.competencyCode) {
      hubEdges.push({
        id: edgeKey(item.id, compNodeId(item.competencyCode)),
        source_id: item.id,
        target_id: compNodeId(item.competencyCode),
        kind: "competency",
      });
    }
  }

  await upsertEdges([...provenanceEdges, ...hubEdges]);
  await pruneOrphanKnowledge();
}

/**
 * Mirror a single video into the graph, then prune any topic left orphaned when
 * a video changed trade. Best-effort callers (syncGraphSafe) swallow failures.
 */
export async function syncVideoGraph(videoId: string): Promise<void> {
  await writeVideoNode(videoId);
  await pruneOrphanTopics();
}

/** Remove a video's node and prune any topic/knowledge its removal left orphaned. */
export async function removeVideoGraph(videoId: string): Promise<void> {
  await deleteVideoNode(videoId);
  await pruneOrphanTopics();
  await pruneOrphanKnowledge();
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
  // Rebuild is deterministic/free (no AI calls), so it does not re-distill atomic
  // knowledge — those nodes persist across rebuilds. Just drop any left orphaned
  // by stale video removal.
  await pruneOrphanKnowledge();
}

/** Read the full persisted graph. */
export async function getGraph(): Promise<KnowledgeGraph> {
  const [{ data: nodeRows, error: nErr }, { data: edgeRows, error: eErr }] = await Promise.all([
    supabase.from("knowledge_nodes").select("*"),
    supabase.from("knowledge_edges").select("*"),
  ]);
  if (nErr) throw nErr;
  if (eErr) throw eErr;

  const knowledgeKinds = new Set<string>(KNOWLEDGE_NODE_KINDS);

  const nodes: GraphNode[] = (nodeRows ?? []).map((r: Record<string, unknown>) => ({
    id: r["id"] as string,
    kind: r["kind"] as GraphNode["kind"],
    label: r["label"] as string,
    trade: (r["trade"] as string | null) ?? null,
    refId: (r["ref_id"] as string | null) ?? null,
    description: (r["description"] as string | null) ?? null,
    confidence: typeof r["confidence"] === "number" ? (r["confidence"] as number) : null,
    verificationStatus: (r["verification_status"] as string) ?? "unverified",
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
    meta: (r["meta"] as Record<string, unknown>) ?? {},
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
      knowledge: nodes.filter((n) => knowledgeKinds.has(n.kind)).length,
    },
    generatedAt: new Date().toISOString(),
  };
}
