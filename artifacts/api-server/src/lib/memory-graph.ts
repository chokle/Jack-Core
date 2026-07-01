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
import { createEmbedding } from "./openai.js";
import type { AtomicKnowledge, KnowledgeCategory } from "./distillation.js";

export const GRAPH_CORE_ID = "__jack__";

/**
 * Graph Intelligence tuning.
 *
 * KNOWLEDGE_MATCH_THRESHOLD is the minimum cosine similarity for two same-category
 * concepts to be treated as the SAME knowledge (and merged onto one canonical
 * node). It is deliberately conservative: merging two genuinely distinct concepts
 * loses information irreversibly, whereas failing to merge a rare near-duplicate
 * only leaves a slightly denser graph. Exact/normalized-label matches bypass this
 * entirely (they always collapse), so this only governs differently-worded dups.
 */
const KNOWLEDGE_MATCH_THRESHOLD = 0.85;
const KNOWLEDGE_MATCH_COUNT = 1;

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
  /** JSON-serialized 1536-dim vector (like videos.embedding). Omit for scaffold nodes. */
  embedding?: string | null;
  meta?: Record<string, unknown>;
}

interface EdgeUpsert {
  id: string;
  source_id: string;
  target_id: string;
  kind: string;
  weight?: number;
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
    if (n.embedding !== undefined) row["embedding"] = n.embedding;
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
    if (e.weight !== undefined) row["weight"] = e.weight;
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

/** A concept identity that collapsed onto a canonical node — a recorded merge. */
export interface MergedConceptRef {
  id: string;
  label: string;
  category: string;
}

/** Clamp a number into [0,1]; non-finite inputs collapse to 0. */
function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Provenance history arrays (confidence over time, verification decisions,
 * rejected evidence) are append-on-change audit logs — they only grow on genuine
 * events, but cap the retained tail so pathological churn can never bloat a
 * node's meta unbounded.
 */
const HISTORY_CAP = 50;
function capHistory<T>(entries: T[]): T[] {
  return entries.length > HISTORY_CAP ? entries.slice(entries.length - HISTORY_CAP) : entries;
}

/**
 * Corroboration-based confidence: combine each independent source's per-extraction
 * confidence with a noisy-OR (1 - ∏(1 - cᵢ)). One weak source stays weak; many
 * independent sources reinforce each other toward (but never past) 1. This makes a
 * concept taught in many videos quantifiably more trustworthy than a one-off.
 */
function noisyOrConfidence(confidences: number[]): number {
  if (confidences.length === 0) return 0;
  let product = 1;
  for (const c of confidences) product *= 1 - clamp01(c);
  return clamp01(1 - product);
}

/** Strip the `video:` node-id prefix back to the raw video UUID. */
function stripVideoPrefix(nodeId: string): string {
  return nodeId.startsWith("video:") ? nodeId.slice("video:".length) : nodeId;
}

/** The concept ids a given video currently corroborates (its provenance targets). */
async function provenanceTargetsForVideo(vNode: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("knowledge_edges")
    .select("target_id")
    .eq("source_id", vNode)
    .eq("kind", "knowledge");
  if (error) throw error;
  return (data ?? [])
    .map((r: Record<string, unknown>) => r["target_id"])
    .filter((t): t is string => typeof t === "string");
}

/** Text embedded for a concept — title carries the identity, description disambiguates. */
function conceptEmbeddingText(title: string, description: string): string {
  const t = title.trim();
  const d = description.trim();
  return d ? `${t}. ${d}` : t;
}

/**
 * One distilled item resolved to a canonical node id. `id` is the node the item
 * collapses onto: its own deterministic id (exact/normalized-label match, or a new
 * node) or an existing differently-worded node of the same category found by
 * embedding similarity. `embeddingJson` is set only when the canonical id came
 * from this concept's own text, so we may (re)write the node's embedding; it is
 * null when the item merged onto another node whose embedding must be left intact.
 */
interface ResolvedConcept {
  id: string;
  category: KnowledgeCategory;
  title: string;
  description: string;
  timestamps: number[];
  confidence: number;
  competencyCode: string | null;
  embeddingJson: string | null;
  /** Other concept identities that merged onto this canonical node in this batch. */
  mergedFrom: MergedConceptRef[];
}

/**
 * Duplicate detection + merge resolution. For each distilled item, decide the
 * canonical node it belongs to:
 *   1. exact normalized-label node already exists → reuse it (always collapse);
 *   2. else a same-category node is embedding-similar above threshold → merge onto
 *      that canonical node (differently-worded duplicate);
 *   3. else mint a new node from this item.
 * Items resolving to the same canonical id are merged (union timestamps, max
 * confidence, most-complete description, first competency). Nothing is written
 * here — the caller persists the deduped set.
 */
async function resolveCanonicalItems(items: AtomicKnowledge[]): Promise<ResolvedConcept[]> {
  if (items.length === 0) return [];

  // Which of the items' own deterministic ids already exist? Exact normalized-label
  // matches always collapse without needing an embedding comparison.
  const exactIds = [...new Set(items.map((i) => i.id))];
  const existing = new Set<string>();
  {
    const { data, error } = await supabase.from("knowledge_nodes").select("id").in("id", exactIds);
    if (error) throw error;
    for (const r of data ?? []) existing.add((r as Record<string, unknown>)["id"] as string);
  }

  const byCanonical = new Map<string, ResolvedConcept>();
  const claimed: string[] = []; // canonical ids already assigned in this batch

  for (const item of items) {
    const embedding = await createEmbedding(conceptEmbeddingText(item.title, item.description));

    let canonicalId = item.id;
    let ownsId = true;

    if (!existing.has(item.id) && embedding.length > 0) {
      // No exact node yet — look for a differently-worded duplicate of the same
      // category to merge onto instead of minting a near-duplicate.
      const { data: matches, error } = await supabase.rpc("match_knowledge_nodes", {
        query_embedding: embedding,
        filter_category: item.category,
        match_threshold: KNOWLEDGE_MATCH_THRESHOLD,
        match_count: KNOWLEDGE_MATCH_COUNT,
        exclude_ids: [item.id, ...claimed],
      });
      if (error) throw error;
      const hit = ((matches ?? []) as Array<{ id?: string }>)[0];
      if (hit?.id) {
        canonicalId = hit.id;
        ownsId = false;
      }
    }

    const embeddingJson = ownsId && embedding.length > 0 ? JSON.stringify(embedding) : null;

    // A differently-identified concept collapsing onto another canonical node is a
    // recorded merge. An exact normalized-label match (item.id === canonicalId) is
    // the same concept re-extracted — identity, not a merge — so it is not recorded.
    const mergeRef: MergedConceptRef | null =
      item.id !== canonicalId
        ? { id: item.id, label: item.title, category: item.category }
        : null;

    const prev = byCanonical.get(canonicalId);
    if (prev) {
      const ts = new Set([...prev.timestamps, ...item.timestamps]);
      prev.timestamps = [...ts].sort((a, b) => a - b);
      prev.confidence = Math.max(prev.confidence, item.confidence);
      if (item.description.length > prev.description.length) prev.description = item.description;
      if (!prev.competencyCode && item.competencyCode) prev.competencyCode = item.competencyCode;
      if (!prev.embeddingJson && embeddingJson) prev.embeddingJson = embeddingJson;
      if (mergeRef && !prev.mergedFrom.some((m) => m.id === mergeRef.id)) {
        prev.mergedFrom.push(mergeRef);
      }
      continue;
    }

    claimed.push(canonicalId);
    byCanonical.set(canonicalId, {
      id: canonicalId,
      category: item.category,
      title: item.title,
      description: item.description,
      timestamps: [...item.timestamps].sort((a, b) => a - b),
      confidence: item.confidence,
      competencyCode: item.competencyCode,
      embeddingJson,
      mergedFrom: mergeRef ? [mergeRef] : [],
    });
  }

  return [...byCanonical.values()];
}

/**
 * Recompute the corroboration-derived fields for a set of atomic-knowledge nodes
 * from their provenance edges (the single source of truth), so every ingestion,
 * merge, or removal converges to the same values regardless of order or replays:
 *
 *  - **confidence** — noisy-OR over each source video's extraction confidence.
 *  - **source & timestamp tracking** — node.meta records the full list of source
 *    videos (with per-video timestamps + confidence), the flattened timestamp
 *    union, and the distinct source count.
 *  - **relationship strength** — each concept→topic / concept→competency hub edge
 *    weight is set to the number of distinct source videos corroborating it; a hub
 *    edge no longer corroborated by any video (weight 0) is deleted.
 *
 * Because everything is derived (not incremented), this is fully idempotent and
 * never double-counts a replayed video.
 */
async function recomputeKnowledgeAggregates(conceptIds: string[]): Promise<void> {
  const ids = [...new Set(conceptIds)].filter((id) => id.startsWith("k:"));
  if (ids.length === 0) return;
  const nowIso = new Date().toISOString();

  const [nodesRes, provRes, hubRes] = await Promise.all([
    supabase.from("knowledge_nodes").select("id, kind, label, trade, meta").in("id", ids),
    supabase
      .from("knowledge_edges")
      .select("source_id, target_id, meta")
      .eq("kind", "knowledge")
      .in("target_id", ids),
    supabase
      .from("knowledge_edges")
      .select("id, source_id, target_id, kind")
      .in("source_id", ids)
      .in("kind", ["topic", "competency"]),
  ]);
  if (nodesRes.error) throw nodesRes.error;
  if (provRes.error) throw provRes.error;
  if (hubRes.error) throw hubRes.error;

  // Group provenance edges by concept.
  const provByConcept = new Map<string, Array<Record<string, unknown>>>();
  for (const e of provRes.data ?? []) {
    const target = (e as Record<string, unknown>)["target_id"] as string;
    (provByConcept.get(target) ?? provByConcept.set(target, []).get(target)!).push(
      e as Record<string, unknown>,
    );
  }
  const hubByConcept = new Map<string, Array<Record<string, unknown>>>();
  for (const e of hubRes.data ?? []) {
    const source = (e as Record<string, unknown>)["source_id"] as string;
    (hubByConcept.get(source) ?? hubByConcept.set(source, []).get(source)!).push(
      e as Record<string, unknown>,
    );
  }

  const nodeUpserts: NodeUpsert[] = [];
  const edgeUpserts: EdgeUpsert[] = [];
  const edgeDeleteIds: string[] = [];

  for (const row of nodesRes.data ?? []) {
    const node = row as Record<string, unknown>;
    const id = node["id"] as string;
    const prov = provByConcept.get(id) ?? [];

    // Per-source provenance, de-duplicated by video (a concept links a video once).
    const sourceMap = new Map<
      string,
      { timestamps: number[]; confidence: number; model: string | null; extractedAt: string | null }
    >();
    const topicCounts = new Map<string, number>();
    const compCounts = new Map<string, number>();
    for (const e of prov) {
      const videoId = stripVideoPrefix(e["source_id"] as string);
      const meta = (e["meta"] as Record<string, unknown>) ?? {};
      const timestamps = Array.isArray(meta["timestamps"])
        ? (meta["timestamps"] as unknown[]).filter((t): t is number => typeof t === "number")
        : [];
      const confidence = typeof meta["confidence"] === "number" ? (meta["confidence"] as number) : 0.5;
      // Extraction provenance — the model + date that distilled this contribution.
      // Pre-feature edges lack these; keep them null rather than fabricating a
      // default so the derived models[] and firstExtractedAt stay honest.
      const model = typeof meta["model"] === "string" ? (meta["model"] as string) : null;
      const extractedAt =
        typeof meta["extractedAt"] === "string" ? (meta["extractedAt"] as string) : null;
      sourceMap.set(videoId, { timestamps, confidence, model, extractedAt });
      const t = typeof meta["trade"] === "string" ? (meta["trade"] as string) : null;
      if (t) topicCounts.set(t, (topicCounts.get(t) ?? 0) + 1);
      const code =
        typeof meta["competencyCode"] === "string" ? (meta["competencyCode"] as string) : null;
      if (code) compCounts.set(code, (compCounts.get(code) ?? 0) + 1);
    }

    const sources = [...sourceMap.entries()].map(([videoId, s]) => ({
      videoId,
      timestamps: s.timestamps,
      confidence: s.confidence,
      model: s.model,
      extractedAt: s.extractedAt,
    }));
    const sourceVideoIds = sources.map((s) => s.videoId);
    const allTimestamps = [...new Set(sources.flatMap((s) => s.timestamps))].sort((a, b) => a - b);
    const confidence = noisyOrConfidence(sources.map((s) => s.confidence));

    const prevMeta = (node["meta"] as Record<string, unknown>) ?? {};

    // Extraction provenance aggregates: distinct models + first/last extraction.
    const models = [...new Set(sources.map((s) => s.model).filter((m): m is string => !!m))];
    const extractDates = sources
      .map((s) => s.extractedAt)
      .filter((d): d is string => !!d)
      .sort();
    const firstExtractedAt = extractDates[0] ?? null;
    const lastExtractedAt = extractDates[extractDates.length - 1] ?? null;

    // Confidence history: append a point only when the derived confidence actually
    // changes, so idempotent replays and full rebuilds never grow the log.
    const prevConfHistory = Array.isArray(prevMeta["confidenceHistory"])
      ? (prevMeta["confidenceHistory"] as Array<Record<string, unknown>>)
      : [];
    const lastConf = prevConfHistory[prevConfHistory.length - 1]?.["confidence"];
    const confidenceHistory =
      lastConf === confidence
        ? prevConfHistory
        : capHistory([...prevConfHistory, { confidence, sourceCount: sources.length, at: nowIso }]);

    // Rejected evidence stays derived-consistent: drop any recorded rejection for a
    // video that currently corroborates this concept again (drop-then-reteach).
    const prevRejected = Array.isArray(prevMeta["rejectedEvidence"])
      ? (prevMeta["rejectedEvidence"] as Array<Record<string, unknown>>)
      : [];
    const rejectedEvidence = capHistory(
      prevRejected.filter((r) => !sourceVideoIds.includes(r["videoId"] as string)),
    );

    nodeUpserts.push({
      id,
      kind: node["kind"] as string,
      label: node["label"] as string,
      trade: (node["trade"] as string | null) ?? null,
      confidence,
      meta: {
        ...prevMeta,
        sourceVideoIds,
        sourceCount: sources.length,
        timestamps: allTimestamps,
        sources,
        models,
        firstExtractedAt,
        lastExtractedAt,
        confidenceHistory,
        rejectedEvidence,
      },
    });

    // Relationship strength: hub-edge weight = distinct corroborating source count.
    for (const edge of hubByConcept.get(id) ?? []) {
      const kind = edge["kind"] as string;
      const targetId = edge["target_id"] as string;
      let weight = 0;
      if (kind === "topic" && targetId.startsWith("topic:")) {
        weight = topicCounts.get(targetId.slice("topic:".length)) ?? 0;
      } else if (kind === "competency" && targetId.startsWith("comp:")) {
        weight = compCounts.get(targetId.slice("comp:".length)) ?? 0;
      }
      if (weight > 0) {
        edgeUpserts.push({
          id: edge["id"] as string,
          source_id: edge["source_id"] as string,
          target_id: targetId,
          kind,
          weight,
        });
      } else {
        edgeDeleteIds.push(edge["id"] as string);
      }
    }
  }

  await upsertNodes(nodeUpserts);
  await upsertEdges(edgeUpserts);
  if (edgeDeleteIds.length > 0) {
    const { error } = await supabase.from("knowledge_edges").delete().in("id", edgeDeleteIds);
    if (error) throw error;
  }
}

/**
 * Distill a video's atomic knowledge into the graph with the Graph Intelligence
 * layer applied. Each distilled item is first resolved to a canonical node —
 * collapsing exact- and embedding-duplicate concepts onto one shared node
 * (merge). We then upsert those canonical nodes and reconcile ONLY this video's
 * provenance edges, whose meta carries this video's timestamps, confidence,
 * trade, and mapped competency. Finally we recompute every affected concept's
 * corroboration-derived fields (confidence, source/timestamp lists, hub-edge
 * weights) from the provenance edges, so the graph converges rather than
 * duplicating and every replay is idempotent.
 *
 * Internal to the pipeline: there is no public route that mutates the graph.
 */
export async function syncVideoKnowledge(
  videoId: string,
  items: AtomicKnowledge[],
  opts: { model?: string | null; extractedAt?: string } = {},
): Promise<void> {
  const vNode = videoNodeId(videoId);
  // Extraction provenance for this run: which model distilled it and when. Default
  // model to null (honest "unknown") rather than fabricating one; the distillation
  // pipeline passes the real analysis model.
  const model = opts.model ?? null;
  const extractedAt = opts.extractedAt ?? new Date().toISOString();

  const { data: video, error: vErr } = await supabase
    .from("videos")
    .select("trade")
    .eq("id", videoId)
    .maybeSingle();
  if (vErr) throw vErr;

  // Concepts this video corroborated before this run — recomputed at the end even
  // if this re-processing no longer extracts them, so their aggregates shrink back.
  const priorTargets = await provenanceTargetsForVideo(vNode);

  // If the video vanished between distillation and persistence, clear any stale
  // provenance it left behind, prune, and reconverge the concepts it touched.
  if (!video) {
    const del = await supabase
      .from("knowledge_edges")
      .delete()
      .eq("source_id", vNode)
      .eq("kind", "knowledge");
    if (del.error) throw del.error;
    await pruneOrphanKnowledge();
    await recomputeKnowledgeAggregates(priorTargets);
    return;
  }
  const trade = (video.trade as string | null) ?? null;

  // Duplicate detection + merge: collapse each item onto its canonical node.
  const resolved = await resolveCanonicalItems(items);
  const canonicalIds = resolved.map((c) => c.id);

  const existingById = new Map<string, Record<string, unknown>>();
  if (canonicalIds.length > 0) {
    const { data: rows, error } = await supabase
      .from("knowledge_nodes")
      .select("id, label, trade, description, confidence, verification_status, meta")
      .in("id", canonicalIds);
    if (error) throw error;
    for (const r of rows ?? []) existingById.set((r as Record<string, unknown>)["id"] as string, r);
  }

  const nodes: NodeUpsert[] = resolved.map((c) => {
    const prev = existingById.get(c.id);
    const prevStatus = prev?.["verification_status"] as string | undefined;
    const prevConfidence =
      typeof prev?.["confidence"] === "number" ? (prev["confidence"] as number) : null;
    const prevDesc = (prev?.["description"] as string | null) ?? "";
    // Keep the most complete description across all contributing videos.
    const description = c.description.length > prevDesc.length ? c.description : prevDesc || c.description;

    // Preserve the node's existing meta (confidence/verification history, prior
    // merge and rejected-evidence records) — recomputeKnowledgeAggregates below
    // re-derives the corroboration fields on top of it. Overwriting meta with just
    // {category} here would wipe the entire provenance audit trail on every
    // re-processing of any corroborating video.
    const prevMeta = (prev?.["meta"] as Record<string, unknown>) ?? {};
    const prevMerged = Array.isArray(prevMeta["mergedFrom"])
      ? (prevMeta["mergedFrom"] as Array<Record<string, unknown>>)
      : [];
    const mergedById = new Map<string, Record<string, unknown>>();
    for (const m of prevMerged) {
      if (typeof m["id"] === "string") mergedById.set(m["id"] as string, m);
    }
    // Record newly merged-in concept identities; the first-seen timestamp wins so
    // replays never rewrite an existing merge record.
    for (const m of c.mergedFrom) {
      if (!mergedById.has(m.id)) mergedById.set(m.id, { ...m, at: extractedAt });
    }
    const mergedFrom = [...mergedById.values()];

    const node: NodeUpsert = {
      id: c.id,
      kind: c.category,
      // First writer wins for the display label/trade so the shared node stays
      // stable; later videos still append provenance via the edge.
      label: (prev?.["label"] as string) || c.title,
      trade: (prev?.["trade"] as string | null) ?? trade,
      ref_id: c.id,
      description: description || null,
      // Interim value; recomputeKnowledgeAggregates overwrites it with the
      // corroboration-based confidence once provenance edges are written.
      confidence: Math.max(prevConfidence ?? 0, c.confidence),
      // Preserve a human verification decision; default new nodes to unverified.
      verification_status:
        prevStatus === "verified" || prevStatus === "rejected" ? prevStatus : "unverified",
      meta: { ...prevMeta, category: c.category, mergedFrom },
    };
    // Only (re)write the embedding when this concept owns the canonical id — never
    // clobber the embedding of a node this item merely merged onto.
    if (c.embeddingJson !== null) node.embedding = c.embeddingJson;
    return node;
  });

  // Ensure competency nodes exist for any mapped codes (never clobber seeded rows).
  const codes = [...new Set(resolved.map((c) => c.competencyCode).filter((c): c is string => !!c))];
  await ensureCompetencyNodes(codes);
  await upsertNodes(nodes);

  // Reconcile only this video's provenance edges: drop the old set, add the new.
  // The edge meta carries everything the aggregate recompute needs (timestamps,
  // confidence, trade, competency); weight = repeated extractions within this video.
  const del = await supabase
    .from("knowledge_edges")
    .delete()
    .eq("source_id", vNode)
    .eq("kind", "knowledge");
  if (del.error) throw del.error;

  const provenanceEdges: EdgeUpsert[] = resolved.map((c) => ({
    id: edgeKey(vNode, c.id),
    source_id: vNode,
    target_id: c.id,
    kind: "knowledge",
    weight: Math.max(1, c.timestamps.length),
    meta: {
      timestamps: c.timestamps,
      confidence: c.confidence,
      trade,
      competencyCode: c.competencyCode,
      // Extraction provenance: the model + date that distilled this contribution.
      model,
      extractedAt,
    },
  }));

  // Additive hub edges: connect each concept to its trade topic and any mapped
  // competency. These accumulate across videos (a growing many-to-many web); their
  // weights are set authoritatively by recomputeKnowledgeAggregates below.
  const hubEdges: EdgeUpsert[] = [];
  for (const c of resolved) {
    if (trade) {
      hubEdges.push({
        id: edgeKey(c.id, topicNodeId(trade)),
        source_id: c.id,
        target_id: topicNodeId(trade),
        kind: "topic",
      });
    }
    if (c.competencyCode) {
      hubEdges.push({
        id: edgeKey(c.id, compNodeId(c.competencyCode)),
        source_id: c.id,
        target_id: compNodeId(c.competencyCode),
        kind: "competency",
      });
    }
  }

  await upsertEdges([...provenanceEdges, ...hubEdges]);
  await pruneOrphanKnowledge();

  // Rejected evidence: concepts this video used to corroborate but no longer does
  // (this re-processing withdrew the evidence). Record it on the surviving dropped
  // nodes only — any that lost their last source were pruned above — keyed by video
  // so replays never duplicate. This runs AFTER prune (so we don't write to a
  // deleted node) and BEFORE recompute (whose {...prevMeta} spread then preserves
  // it, and which reconciles the entry away if a later run re-teaches the concept).
  const droppedIds = priorTargets.filter((t) => !canonicalIds.includes(t));
  if (droppedIds.length > 0) {
    const { data: droppedRows, error: dropErr } = await supabase
      .from("knowledge_nodes")
      .select("id, meta")
      .in("id", droppedIds);
    if (dropErr) throw dropErr;
    for (const row of droppedRows ?? []) {
      const r = row as Record<string, unknown>;
      const meta = (r["meta"] as Record<string, unknown>) ?? {};
      const prevRejected = Array.isArray(meta["rejectedEvidence"])
        ? (meta["rejectedEvidence"] as Array<Record<string, unknown>>)
        : [];
      if (prevRejected.some((e) => e["videoId"] === videoId)) continue;
      const rejectedEvidence = capHistory([
        ...prevRejected,
        { videoId, at: extractedAt, reason: "no-longer-extracted" },
      ]);
      const { error: updErr } = await supabase
        .from("knowledge_nodes")
        .update({ meta: { ...meta, rejectedEvidence }, updated_at: new Date().toISOString() })
        .eq("id", r["id"] as string);
      if (updErr) throw updErr;
    }
  }

  // Reconverge every concept this run touched — the ones it now corroborates and
  // any it dropped — so confidence, provenance, and edge weights stay in sync.
  await recomputeKnowledgeAggregates([...canonicalIds, ...priorTargets]);
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
  // Capture the concepts this video corroborated before its node (and, by cascade,
  // its provenance edges) are deleted, so the survivors can reconverge afterward.
  const affected = await provenanceTargetsForVideo(videoNodeId(videoId));
  await deleteVideoNode(videoId);
  await pruneOrphanTopics();
  await pruneOrphanKnowledge();
  // Concepts that lost their last source were pruned above; recompute those that
  // remain so confidence, provenance, and hub-edge weights drop to reflect the loss.
  await recomputeKnowledgeAggregates(affected);
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

  // Reconverge every surviving atomic concept from its provenance edges, so a
  // rebuild self-heals stale confidence, source lists, and hub-edge weights (e.g.
  // a DB written before the Graph Intelligence layer existed).
  const { data: kNodes, error: kErr } = await supabase
    .from("knowledge_nodes")
    .select("id")
    .in("kind", [...KNOWLEDGE_NODE_KINDS]);
  if (kErr) throw kErr;
  const knowledgeIds = (kNodes ?? []).map((r: Record<string, unknown>) => r["id"] as string);
  await recomputeKnowledgeAggregates(knowledgeIds);
}

/** The human review decisions a reviewer may record on a distilled concept. */
export const VERIFICATION_STATUSES = ["verified", "rejected", "unverified"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/**
 * Record a reviewer's verification decision on a single atomic-knowledge node.
 *
 * Only distilled concept nodes carry a human `verification_status` (the merge
 * logic preserves a `verified`/`rejected` decision across re-processing), so
 * this refuses to touch scaffold nodes (core/topic/competency/video). Returns
 * the updated node, or null if no such knowledge node exists. This is the ONE
 * place a human decision is written — it is admin-gated at the route layer since
 * the API holds the Supabase service-role key and is otherwise unauthenticated.
 */
export async function setNodeVerification(
  nodeId: string,
  status: VerificationStatus,
): Promise<GraphNode | null> {
  const { data: existing, error: readErr } = await supabase
    .from("knowledge_nodes")
    .select("kind, verification_status, meta")
    .eq("id", nodeId)
    .maybeSingle();
  if (readErr) throw readErr;
  if (!existing) return null;

  const ex = existing as Record<string, unknown>;
  const kind = ex["kind"] as string;
  if (!KNOWLEDGE_NODE_KINDS.includes(kind as KnowledgeNodeKind)) return null;

  // Verification history: append a transition only when the decision actually
  // changes, so re-affirming the same status never grows the log. Reviewer
  // identity is intentionally omitted — that belongs to a separate signed-in
  // reviewer feature; here we record only what changed and when.
  const prevStatus = ((ex["verification_status"] as string | null) ?? "unverified") as VerificationStatus;
  const prevMeta = (ex["meta"] as Record<string, unknown>) ?? {};
  const prevHistory = Array.isArray(prevMeta["verificationHistory"])
    ? (prevMeta["verificationHistory"] as Array<Record<string, unknown>>)
    : [];
  const verificationHistory =
    prevStatus === status
      ? prevHistory
      : capHistory([
          ...prevHistory,
          { from: prevStatus, to: status, at: new Date().toISOString() },
        ]);

  const { data: updated, error: updErr } = await supabase
    .from("knowledge_nodes")
    .update({
      verification_status: status,
      meta: { ...prevMeta, verificationHistory },
      updated_at: new Date().toISOString(),
    })
    .eq("id", nodeId)
    .select("*")
    .single();
  if (updErr) throw updErr;

  const r = updated as Record<string, unknown>;
  return {
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
  };
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
