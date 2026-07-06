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
import { logger } from "./logger.js";
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

/**
 * Mentor-path (Interview Mode) decision bands — reinforcement-first policy.
 *
 * Mentor answers must strengthen the SAME canonical concepts rather than spawn
 * near-duplicates, so mentor concepts get a three-band decision instead of the
 * video path's single threshold:
 *   - similarity ≥ MENTOR_REINFORCE_THRESHOLD (or an exact id / recorded alias
 *     match) → reinforce the existing canonical node;
 *   - similarity in [MENTOR_NOVELTY_THRESHOLD, MENTOR_REINFORCE_THRESHOLD) →
 *     plausible-but-uncertain: queue as a pending candidate OUTSIDE the live
 *     graph (never auto-create) so a human can review it later;
 *   - below MENTOR_NOVELTY_THRESHOLD against every signal → confidently novel:
 *     create a new node.
 * The video path shares the exact-id, alias-index, and ≥ threshold semantic
 * signals, but deliberately keeps CREATE for the middle band (see
 * resolveCanonicalItems) — video knowledge must land in the graph immediately.
 */
const MENTOR_REINFORCE_THRESHOLD = KNOWLEDGE_MATCH_THRESHOLD;
const MENTOR_NOVELTY_THRESHOLD = 0.7;
/** Top semantic neighbors recorded on a queued candidate for later review. */
const MENTOR_NEIGHBOR_COUNT = 3;
/** Cap the recorded alternate wordings on a canonical node. */
const ALIAS_CAP = 25;

const topicNodeId = (trade: string) => `topic:${trade}`;
const compNodeId = (code: string) => `comp:${code}`;
const videoNodeId = (id: string) => `video:${id}`;
const mentorNodeId = (id: string) => `mentor:${id}`;
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
  kind: "core" | "topic" | "competency" | "video" | "mentor" | KnowledgeNodeKind;
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
    // Always set weight explicitly (default 1, matching the DB column default).
    // PostgREST bulk upserts unify the column set across the batch, so if any
    // row in the batch carries `weight` while others omit it, the omitters are
    // inserted with an explicit NULL — violating the NOT NULL constraint — rather
    // than falling back to the column default. Mixed batches (weighted provenance
    // edges + weightless hub edges) hit exactly this, so never leave it undefined.
    row["weight"] = e.weight ?? 1;
    // Same NOT NULL / mixed-batch hazard as weight — meta defaults to {} in the
    // DB, but a mixed batch would insert an explicit NULL for rows that omit it.
    row["meta"] = e.meta ?? {};
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
  const [comps, vids, mentors, topics] = await Promise.all([
    supabase.from("competencies").select("trade"),
    supabase.from("videos").select("trade"),
    // Mentor source nodes (Interview Mode) also anchor a topic hub — a trade with
    // only interviewed mentors (e.g. Heavy Equipment Operator, which has no seeded
    // competencies) must keep its hub even when no video references it.
    supabase.from("knowledge_nodes").select("trade").eq("kind", "mentor"),
    supabase.from("knowledge_nodes").select("id, trade").eq("kind", "topic"),
  ]);
  if (comps.error) throw comps.error;
  if (vids.error) throw vids.error;
  if (mentors.error) throw mentors.error;
  if (topics.error) throw topics.error;

  const keep = new Set<string>();
  for (const r of [...(comps.data ?? []), ...(vids.data ?? []), ...(mentors.data ?? [])]) {
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
export async function pruneOrphanKnowledge(): Promise<void> {
  const [nodes, edges] = await Promise.all([
    supabase.from("knowledge_nodes").select("id, kind, meta").in("kind", [...KNOWLEDGE_NODE_KINDS]),
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
    .map((r) => r as Record<string, unknown>)
    // Reviewer-restored (curated) concepts are intentionally source-free — the
    // reviewer, not a video/mentor, vouches for them — so they have no
    // provenance edge but must NOT be pruned.
    .filter((r) => ((r["meta"] as Record<string, unknown>) ?? {})["curated"] !== true)
    .map((r) => r["id"] as string)
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
  /** New alternate wordings to record on the canonical node's alias list. */
  newAliases: string[];
}

/** Read the alias list (alternate wordings) recorded on a node's meta. */
function metaAliases(meta: Record<string, unknown> | null | undefined): string[] {
  const raw = meta?.["aliases"];
  return Array.isArray(raw) ? raw.filter((a): a is string => typeof a === "string") : [];
}

/**
 * Build the normalized label + recorded-alias index across every knowledge
 * category (first writer wins on collisions — deterministic and stable). Shared
 * by BOTH the video path (resolveCanonicalItems) and the mentor path
 * (resolveMentorConcepts), so a wording a mentor taught as an alias also stops
 * a re-uploaded or differently-worded video from minting a duplicate node.
 */
async function buildKnowledgeAliasIndex(): Promise<Map<string, { id: string; label: string }>> {
  const aliasIndex = new Map<string, { id: string; label: string }>();
  const { data, error } = await supabase
    .from("knowledge_nodes")
    .select("id, kind, label, meta")
    .in("kind", [...KNOWLEDGE_NODE_KINDS]);
  if (error) throw error;
  for (const row of data ?? []) {
    const r = row as Record<string, unknown>;
    const id = r["id"] as string;
    const label = (r["label"] as string) ?? "";
    const entry = { id, label };
    const normLabel = normalizeConcept(label);
    if (normLabel && !aliasIndex.has(normLabel)) aliasIndex.set(normLabel, entry);
    for (const alias of metaAliases(r["meta"] as Record<string, unknown>)) {
      const normAlias = normalizeConcept(alias);
      if (normAlias && !aliasIndex.has(normAlias)) aliasIndex.set(normAlias, entry);
    }
  }
  return aliasIndex;
}

/**
 * Merge grown alias wordings into a node's existing alias list — deduped by
 * normalized form against the label and prior aliases, capped at ALIAS_CAP.
 * Used by both persist paths so alias growth behaves identically for video-
 * and mentor-sourced wordings.
 */
function growAliases(label: string, prevMeta: Record<string, unknown>, newAliases: string[]): string[] {
  const prevAliases = metaAliases(prevMeta);
  const seenNorms = new Set([normalizeConcept(label), ...prevAliases.map(normalizeConcept)]);
  const aliases = [...prevAliases];
  for (const a of newAliases) {
    const norm = normalizeConcept(a);
    if (!norm || seenNorms.has(norm)) continue;
    seenNorms.add(norm);
    aliases.push(a);
  }
  return aliases.slice(-ALIAS_CAP);
}

/**
 * Duplicate detection + merge resolution for video-distilled items. For each
 * distilled item, decide the canonical node it belongs to:
 *   1. exact normalized-label node already exists → reuse it (always collapse);
 *   2. else its normalized title equals an existing node's label or a recorded
 *      alias/alternate wording — across ALL knowledge categories, so a wording
 *      mentors already taught as an alias collapses onto the same node instead
 *      of splitting the concept on re-upload;
 *   3. else a same-category node is embedding-similar above threshold → merge onto
 *      that canonical node (differently-worded duplicate);
 *   4. else mint a new node from this item.
 * Deliberate divergence from the mentor path: there is NO queue band for videos.
 * A middle-band (0.70–0.85) video concept CREATES a new node rather than being
 * held as a pending candidate, because video provenance edges must exist
 * immediately (citations/search reference them) and each re-sync reconciles the
 * video's full edge set — a queued concept would silently drop the video's
 * knowledge until a reviewer acted.
 * When a differently-worded item collapses onto an existing node, the video's
 * wording is recorded as an alias so future matches (video OR mentor) hit the
 * alias index directly. Items resolving to the same canonical id are merged
 * (union timestamps, max confidence, most-complete description, first
 * competency). Nothing is written here — the caller persists the deduped set.
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

  const aliasIndex = await buildKnowledgeAliasIndex();

  const byCanonical = new Map<string, ResolvedConcept>();
  const claimed: string[] = []; // canonical ids already assigned in this batch

  for (const item of items) {
    const normTitle = normalizeConcept(item.title);
    const embedding = await createEmbedding(conceptEmbeddingText(item.title, item.description));

    let canonicalId = item.id;
    let ownsId = true;
    let matchedLabel: string | null = null;

    if (!existing.has(item.id)) {
      const aliasHit = aliasIndex.get(normTitle);
      if (aliasHit && aliasHit.id !== item.id) {
        // The wording already names an existing node (label or recorded alias).
        canonicalId = aliasHit.id;
        ownsId = false;
        matchedLabel = aliasHit.label;
      } else if (embedding.length > 0) {
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
        const hit = ((matches ?? []) as Array<{ id?: string; label?: string }>)[0];
        if (hit?.id) {
          canonicalId = hit.id;
          ownsId = false;
          matchedLabel = hit.label ?? null;
        }
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

    // Record this video's wording as an alias when it collapsed onto a
    // differently-labelled node, so the next differently-worded upload (or a
    // mentor using the same wording) hits the alias index directly.
    const newAlias =
      !ownsId && matchedLabel !== null && normalizeConcept(matchedLabel) !== normTitle
        ? item.title
        : null;
    if (newAlias && !aliasIndex.has(normTitle)) {
      aliasIndex.set(normTitle, { id: canonicalId, label: matchedLabel ?? item.title });
    }

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
      if (newAlias && !prev.newAliases.some((a) => normalizeConcept(a) === normTitle)) {
        prev.newAliases.push(newAlias);
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
      newAliases: newAlias ? [newAlias] : [],
    });
  }

  return [...byCanonical.values()];
}

/** How a single mentor-distilled concept landed relative to the live graph. */
export type MentorConceptOutcome = "reinforced" | "created" | "queued";

/** Per-item mentor ingestion result, keyed by the distilled item's own id. */
export interface MentorKnowledgeOutcome {
  /** The distilled item's deterministic id (k:<category>:<slug>). */
  itemId: string;
  /** The live node reinforced/created, or null when the item was queued. */
  canonicalId: string | null;
  title: string;
  category: KnowledgeCategory;
  outcome: MentorConceptOutcome;
  /** Label of the existing node this item reinforced (null for created/queued). */
  matchedLabel: string | null;
}

/** A near-match recorded on a queued candidate so reviewers see the context. */
export interface CandidateMatch {
  nodeId: string;
  label: string;
  similarity: number;
  /** Read-time validity annotation (set by listKnowledgeCandidates, never stored). */
  validity?: "live" | "redirected" | "gone";
  /** The node this match currently resolves to (itself when live, survivor when redirected). */
  currentNodeId?: string | null;
  currentLabel?: string | null;
}

/** A mentor concept held back as a pending candidate (uncertain middle band). */
interface QueuedMentorConcept {
  item: AtomicKnowledge;
  bestMatches: CandidateMatch[];
}

/** ResolvedConcept plus the mentor-path decision that produced it. */
interface MentorResolvedConcept extends ResolvedConcept {
  /** True when this collapses onto a node that already existed in the graph. */
  reinforced: boolean;
  matchedLabel: string | null;
}

/**
 * Reinforcement-first resolution for mentor-distilled concepts (Interview Mode
 * only — the video path uses resolveCanonicalItems, which shares the exact-id,
 * alias-index, and high-similarity signals but creates instead of queuing in
 * the middle band). Each item is matched against multiple signals, in order of
 * confidence:
 *   1. its own deterministic id already exists (canonical title match);
 *   2. its normalized title equals an existing node's label or a recorded
 *      alias/alternate wording — across ALL knowledge categories, so a slang or
 *      regional wording that names an existing concept reinforces that concept;
 *   3. top semantic neighbors (same category, plus the concept category for
 *      slang/regional terms) fetched down to the novelty threshold:
 *        best ≥ reinforce-threshold → reinforce that canonical node,
 *        best in the middle band    → queue as a pending candidate,
 *        nothing above the band     → confidently novel, create a new node.
 * When a differently-worded item confidently resolves to an existing node, the
 * mentor's wording is recorded as an alias so future matches get stronger.
 */
async function resolveMentorConcepts(items: AtomicKnowledge[]): Promise<{
  resolved: MentorResolvedConcept[];
  queued: QueuedMentorConcept[];
  outcomes: MentorKnowledgeOutcome[];
}> {
  if (items.length === 0) return { resolved: [], queued: [], outcomes: [] };

  // Signal 1: which items' own deterministic ids already exist?
  const exactIds = [...new Set(items.map((i) => i.id))];
  const existing = new Set<string>();
  {
    const { data, error } = await supabase.from("knowledge_nodes").select("id").in("id", exactIds);
    if (error) throw error;
    for (const r of data ?? []) existing.add((r as Record<string, unknown>)["id"] as string);
  }

  // Signal 2: normalized label + recorded alias index across every knowledge
  // category (shared with the video path).
  const aliasIndex = await buildKnowledgeAliasIndex();

  const byCanonical = new Map<string, MentorResolvedConcept>();
  const queuedById = new Map<string, QueuedMentorConcept>();
  const outcomes: MentorKnowledgeOutcome[] = [];
  const claimed: string[] = [];

  for (const item of items) {
    const normTitle = normalizeConcept(item.title);
    const embedding = await createEmbedding(conceptEmbeddingText(item.title, item.description));

    let canonicalId = item.id;
    let ownsId = true;
    let matchedLabel: string | null = null;
    let outcome: MentorConceptOutcome;
    let queuedMatches: CandidateMatch[] | null = null;

    if (existing.has(item.id)) {
      // Canonical title match — the node already lives in the graph.
      outcome = "reinforced";
    } else {
      const aliasHit = aliasIndex.get(normTitle);
      if (aliasHit && aliasHit.id !== item.id) {
        canonicalId = aliasHit.id;
        ownsId = false;
        matchedLabel = aliasHit.label;
        outcome = "reinforced";
      } else if (embedding.length > 0) {
        // Signal 3: top semantic neighbors down to the novelty threshold. Slang
        // and regional terms also search the concept category, since a trade
        // wording usually names a concept rather than another slang node.
        const categories: KnowledgeCategory[] =
          item.category === "slang" || item.category === "regional_term"
            ? [item.category, "concept"]
            : [item.category];
        const matches: CandidateMatch[] = [];
        for (const cat of categories) {
          const { data, error } = await supabase.rpc("match_knowledge_nodes", {
            query_embedding: embedding,
            filter_category: cat,
            match_threshold: MENTOR_NOVELTY_THRESHOLD,
            match_count: MENTOR_NEIGHBOR_COUNT,
            exclude_ids: [item.id, ...claimed],
          });
          if (error) throw error;
          for (const m of (data ?? []) as Array<{ id?: string; label?: string; similarity?: number }>) {
            if (typeof m.id === "string" && typeof m.similarity === "number") {
              matches.push({ nodeId: m.id, label: m.label ?? m.id, similarity: m.similarity });
            }
          }
        }
        matches.sort((a, b) => b.similarity - a.similarity);
        const best = matches[0];
        if (best && best.similarity >= MENTOR_REINFORCE_THRESHOLD) {
          canonicalId = best.nodeId;
          ownsId = false;
          matchedLabel = best.label;
          outcome = "reinforced";
        } else if (best) {
          // Plausible-but-uncertain: hold OUTSIDE the live graph for review.
          outcome = "queued";
          queuedMatches = matches.slice(0, MENTOR_NEIGHBOR_COUNT);
        } else {
          outcome = "created";
        }
      } else {
        outcome = "created";
      }
    }

    if (outcome === "queued") {
      const prev = queuedById.get(item.id);
      if (prev) {
        prev.item.confidence = Math.max(prev.item.confidence, item.confidence);
        if (item.description.length > prev.item.description.length) {
          prev.item.description = item.description;
        }
      } else {
        queuedById.set(item.id, { item: { ...item }, bestMatches: queuedMatches ?? [] });
      }
      outcomes.push({
        itemId: item.id,
        canonicalId: null,
        title: item.title,
        category: item.category,
        outcome: "queued",
        matchedLabel: null,
      });
      continue;
    }

    const embeddingJson = ownsId && embedding.length > 0 ? JSON.stringify(embedding) : null;
    const mergeRef: MergedConceptRef | null =
      item.id !== canonicalId
        ? { id: item.id, label: item.title, category: item.category }
        : null;
    // Record the mentor's wording as an alias when it confidently resolved to a
    // differently-labelled node, so the next mentor using the same wording hits
    // the alias index directly.
    const newAlias = !ownsId && matchedLabel !== null && normalizeConcept(matchedLabel) !== normTitle
      ? item.title
      : null;
    if (newAlias && !aliasIndex.has(normTitle)) {
      aliasIndex.set(normTitle, { id: canonicalId, label: matchedLabel ?? item.title });
    }

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
      if (newAlias && !prev.newAliases.some((a) => normalizeConcept(a) === normTitle)) {
        prev.newAliases.push(newAlias);
      }
      outcomes.push({
        itemId: item.id,
        canonicalId,
        title: item.title,
        category: item.category,
        outcome: prev.reinforced ? "reinforced" : "created",
        matchedLabel: prev.reinforced ? (prev.matchedLabel ?? prev.title) : null,
      });
      continue;
    }

    const reinforced = outcome === "reinforced";
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
      reinforced,
      matchedLabel,
      newAliases: newAlias ? [newAlias] : [],
    });
    outcomes.push({
      itemId: item.id,
      canonicalId,
      title: item.title,
      category: item.category,
      outcome,
      matchedLabel,
    });
  }

  return { resolved: [...byCanonical.values()], queued: [...queuedById.values()], outcomes };
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

    // Reviewer-restored (curated) concepts with no provenance are vouched for by
    // the reviewer, not derived from sources — leave their confidence and hub
    // edges intact instead of zeroing them out on a rebuild.
    if (prov.length === 0 && ((node["meta"] as Record<string, unknown>) ?? {})["curated"] === true) {
      continue;
    }

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
): Promise<GraphWriteManifest> {
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
    // Nothing landed (the video is gone) — an empty manifest verifies as an
    // honest no-op rather than a failed write.
    return {
      scope: "video",
      refId: videoId,
      sourceNodeId: vNode,
      expectedNodeIds: [],
      expectedEdgeIds: [],
      embeddingNodeIds: [],
    };
  }
  const trade = (video.trade as string | null) ?? null;

  // Duplicate detection + merge: collapse each item onto its canonical node.
  const resolved = await resolveCanonicalItems(items);
  const canonicalIds = resolved.map((c) => c.id);

  const existingById = new Map<string, Record<string, unknown>>();
  if (canonicalIds.length > 0) {
    const { data: rows, error } = await supabase
      .from("knowledge_nodes")
      .select("id, kind, label, trade, description, confidence, verification_status, meta")
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

    // Grow the node's alias list with this video's alternate wordings (deduped
    // against the label and prior aliases, capped) so future differently-worded
    // uploads and mentor answers match directly via the alias index.
    const label = (prev?.["label"] as string) || c.title;
    const aliases = growAliases(label, prevMeta, c.newAliases);

    const node: NodeUpsert = {
      id: c.id,
      // Preserve the node's existing kind: an alias-index match may collapse a
      // differently-categorized wording onto a node of another category, and the
      // canonical node's identity must not flip on merge.
      kind: (prev?.["kind"] as string) || c.category,
      // First writer wins for the display label/trade so the shared node stays
      // stable; later videos still append provenance via the edge.
      label,
      trade: (prev?.["trade"] as string | null) ?? trade,
      ref_id: c.id,
      description: description || null,
      // Interim value; recomputeKnowledgeAggregates overwrites it with the
      // corroboration-based confidence once provenance edges are written.
      confidence: Math.max(prevConfidence ?? 0, c.confidence),
      // Preserve any elevated status: a human decision (verified/rejected) always
      // wins, and a concept a mentor already corroborated stays 'mentor_supplied'
      // — re-processing a video that also teaches it must never downgrade it.
      // Video-only concepts default to unverified.
      verification_status:
        prevStatus === "verified" || prevStatus === "rejected" || prevStatus === "mentor_supplied"
          ? prevStatus
          : "unverified",
      meta: {
        ...prevMeta,
        category: (prevMeta["category"] as string) || c.category,
        mergedFrom,
        aliases,
      },
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

  // Report exactly what this write was supposed to land so the caller can verify
  // it against the persisted graph (see verifyGraphWrite). embeddingNodeIds are
  // the concepts THIS run newly minted (own their canonical id), which must carry
  // an embedding for semantic search / duplicate matching.
  return {
    scope: "video",
    refId: videoId,
    sourceNodeId: vNode,
    expectedNodeIds: canonicalIds,
    expectedEdgeIds: provenanceEdges.map((e) => e.id),
    embeddingNodeIds: resolved.filter((c) => c.embeddingJson !== null).map((c) => c.id),
  };
}

/**
 * The verification status to set on a concept a mentor corroborates: a human
 * decision (verified/rejected) always wins; otherwise the concept is at least
 * 'mentor_supplied' (an already-mentor_supplied node simply stays put).
 */
function mentorVerification(prevStatus: string | undefined): string {
  if (prevStatus === "verified" || prevStatus === "rejected") return prevStatus;
  return "mentor_supplied";
}

/**
 * Ensure a mentor source node exists and is linked under its trade topic hub (or
 * the core when the trade is unknown), mirroring how a video node hangs off its
 * topic. Idempotent; safe to call before every answer sync.
 */
async function ensureMentorNode(
  profileId: string,
  name: string,
  trade: string | null,
): Promise<void> {
  const mNode = mentorNodeId(profileId);
  const nodes: NodeUpsert[] = [{ id: GRAPH_CORE_ID, kind: "core", label: "JACK" }];
  const edges: EdgeUpsert[] = [];

  if (trade) {
    nodes.push({ id: topicNodeId(trade), kind: "topic", label: trade, trade });
    edges.push({
      id: edgeKey(GRAPH_CORE_ID, topicNodeId(trade)),
      source_id: GRAPH_CORE_ID,
      target_id: topicNodeId(trade),
      kind: "topic",
    });
  }

  nodes.push({
    id: mNode,
    kind: "mentor",
    label: name,
    trade,
    ref_id: profileId,
    meta: { mentorProfileId: profileId, trade: trade ?? undefined },
  });

  const parent = trade ? topicNodeId(trade) : GRAPH_CORE_ID;
  edges.push({ id: edgeKey(parent, mNode), source_id: parent, target_id: mNode, kind: "mentor" });

  await upsertNodes(nodes);
  await upsertEdges(edges);
}

/**
 * Persist one interviewed mentor's distilled answer knowledge into the SAME
 * shared graph the video pipeline feeds. The mentor is a source node
 * (`mentor:<profileId>`), exactly parallel to a video node: its provenance edges
 * (kind='knowledge') reinforce canonical concept nodes, so a concept an expert
 * confirms gains an extra corroborating source in the noisy-OR confidence —
 * collapsing onto the very nodes videos already teach rather than duplicating
 * them. Concepts a mentor corroborates are marked 'mentor_supplied' unless a
 * human already decided verified/rejected.
 *
 * Unlike the video path (which reconciles a video's whole edge set by
 * delete-then-reinsert on every re-analysis), a mentor accumulates knowledge one
 * answer at a time, so this is ADDITIVE: each concept's mentor→concept edge is
 * upserted with merged meta (union of contributing answerIds, max confidence).
 * Replaying the same answer is therefore idempotent — the deterministic edge id
 * plus answerId de-dup keeps the corroboration count stable.
 *
 * Resolution is reinforcement-first (resolveMentorConcepts): concepts that
 * confidently match existing knowledge reinforce it, confidently novel concepts
 * create nodes, and plausible-but-uncertain concepts are queued as pending rows
 * in knowledge_candidates OUTSIDE the live graph. Returns the per-item outcomes
 * so callers can preview reinforced/created/queued to the mentor.
 */
export async function syncMentorAnswerKnowledge(
  mentorProfileId: string,
  mentorName: string,
  items: AtomicKnowledge[],
  opts: {
    answerId: string;
    trade?: string | null;
    model?: string | null;
    extractedAt?: string;
    sessionId?: string | null;
  },
): Promise<MentorKnowledgeOutcome[]> {
  const trade = opts.trade ?? null;
  const model = opts.model ?? null;
  const extractedAt = opts.extractedAt ?? new Date().toISOString();
  const { answerId } = opts;

  // Always ensure the mentor source node exists and is wired into the graph, even
  // if this particular answer distilled nothing.
  await ensureMentorNode(mentorProfileId, mentorName, trade);
  if (items.length === 0) return [];

  // Reinforcement-first resolution: reinforce / create / queue per concept.
  const { resolved, queued, outcomes } = await resolveMentorConcepts(items);
  const canonicalIds = resolved.map((c) => c.id);

  // Queued candidates live OUTSIDE the live graph until reviewed. The row id is
  // deterministic per (answer, item) and inserted with ignoreDuplicates, so
  // replaying an answer never duplicates a candidate or resets a reviewed status.
  if (queued.length > 0) {
    const rows = queued.map((q) => ({
      id: `cand:${answerId}:${q.item.id}`,
      status: "pending",
      title: q.item.title,
      description: q.item.description || null,
      category: q.item.category,
      trade,
      confidence: q.item.confidence,
      competency_code: q.item.competencyCode,
      mentor_profile_id: mentorProfileId,
      mentor_name: mentorName,
      answer_id: answerId,
      session_id: opts.sessionId ?? null,
      best_matches: q.bestMatches,
    }));
    const { error } = await supabase
      .from("knowledge_candidates")
      .upsert(rows, { onConflict: "id", ignoreDuplicates: true });
    if (error) throw error;
  }

  if (resolved.length === 0) return outcomes;

  await persistMentorResolvedConcepts(mentorProfileId, resolved, {
    answerId,
    trade,
    model,
    extractedAt,
  });
  return outcomes;
}

/**
 * Persist a batch of mentor-resolved concepts into the live graph: canonical
 * node upsert (label first-writer-wins, longest description, alias growth,
 * 'mentor_supplied' verification unless a human already decided), ADDITIVE
 * mentor→concept provenance edges deduped by answerId, hub edges, and the
 * aggregate recompute. This is the ONE write path for mentor knowledge — both
 * ingestion-time reinforcement (syncMentorAnswerKnowledge) and Knowledge Review
 * resolutions (resolveKnowledgeCandidate) route through it, so replays are
 * idempotent everywhere.
 */
async function persistMentorResolvedConcepts(
  mentorProfileId: string,
  resolved: MentorResolvedConcept[],
  opts: {
    answerId: string;
    trade: string | null;
    model: string | null;
    extractedAt: string;
  },
): Promise<void> {
  if (resolved.length === 0) return;
  const mNode = mentorNodeId(mentorProfileId);
  const { answerId, trade, model, extractedAt } = opts;
  const canonicalIds = resolved.map((c) => c.id);

  const existingById = new Map<string, Record<string, unknown>>();
  if (canonicalIds.length > 0) {
    const { data: rows, error } = await supabase
      .from("knowledge_nodes")
      .select("id, kind, label, trade, description, confidence, verification_status, meta")
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
    const description =
      c.description.length > prevDesc.length ? c.description : prevDesc || c.description;

    // Preserve the node's meta ledger (recompute re-derives corroboration on top)
    // and append any newly merged-in concept identities (first-seen wins).
    const prevMeta = (prev?.["meta"] as Record<string, unknown>) ?? {};
    const prevMerged = Array.isArray(prevMeta["mergedFrom"])
      ? (prevMeta["mergedFrom"] as Array<Record<string, unknown>>)
      : [];
    const mergedById = new Map<string, Record<string, unknown>>();
    for (const m of prevMerged) {
      if (typeof m["id"] === "string") mergedById.set(m["id"] as string, m);
    }
    for (const m of c.mergedFrom) {
      if (!mergedById.has(m.id)) mergedById.set(m.id, { ...m, at: extractedAt });
    }
    const mergedFrom = [...mergedById.values()];

    // Grow the node's alias list with the mentor's alternate wordings (deduped by
    // normalized form against the label and existing aliases, capped) so future
    // mentor wordings match directly.
    const label = (prev?.["label"] as string) || c.title;
    const cappedAliases = growAliases(label, prevMeta, c.newAliases);

    const node: NodeUpsert = {
      id: c.id,
      // Preserve the node's existing kind — a cross-category alias match must
      // not flip the canonical node's identity on merge.
      kind: (prev?.["kind"] as string) || c.category,
      // First writer wins for the display label/trade so a node videos already
      // created keeps its identity; the mentor still appends provenance.
      label,
      trade: (prev?.["trade"] as string | null) ?? trade,
      ref_id: c.id,
      description: description || null,
      // Interim value; recomputeKnowledgeAggregates overwrites it below.
      confidence: Math.max(prevConfidence ?? 0, c.confidence),
      verification_status: mentorVerification(prevStatus),
      meta: {
        ...prevMeta,
        category: (prevMeta["category"] as string) || c.category,
        mergedFrom,
        aliases: cappedAliases,
      },
    };
    if (c.embeddingJson !== null) node.embedding = c.embeddingJson;
    return node;
  });

  const codes = [...new Set(resolved.map((c) => c.competencyCode).filter((c): c is string => !!c))];
  await ensureCompetencyNodes(codes);
  await upsertNodes(nodes);

  // Additive provenance: merge this answer's contribution into any existing
  // mentor→concept edge (union answerIds, max confidence) rather than replacing
  // the mentor's prior edges. Reading the existing edges first makes replaying
  // the same answerId a no-op.
  const edgeIds = resolved.map((c) => edgeKey(mNode, c.id));
  const existingEdges = new Map<string, Record<string, unknown>>();
  if (edgeIds.length > 0) {
    const { data: rows, error } = await supabase
      .from("knowledge_edges")
      .select("id, meta")
      .in("id", edgeIds);
    if (error) throw error;
    for (const r of rows ?? []) existingEdges.set((r as Record<string, unknown>)["id"] as string, r);
  }

  const provenanceEdges: EdgeUpsert[] = resolved.map((c) => {
    const id = edgeKey(mNode, c.id);
    const prevMeta = (existingEdges.get(id)?.["meta"] as Record<string, unknown>) ?? {};
    const prevAnswerIds = Array.isArray(prevMeta["answerIds"])
      ? (prevMeta["answerIds"] as unknown[]).filter((a): a is string => typeof a === "string")
      : [];
    const answerIds = prevAnswerIds.includes(answerId)
      ? prevAnswerIds
      : [...prevAnswerIds, answerId];
    const prevConf =
      typeof prevMeta["confidence"] === "number" ? (prevMeta["confidence"] as number) : 0;
    // Per-answer confidence ledger keyed by answerId. Recording it here is what
    // lets a later withdrawal recompute the true max over the SURVIVING answers,
    // instead of leaving the edge stuck at a withdrawn answer's high confidence.
    const prevAnswerConfidences =
      prevMeta["answerConfidences"] && typeof prevMeta["answerConfidences"] === "object"
        ? (prevMeta["answerConfidences"] as Record<string, number>)
        : {};
    const answerConfidences = { ...prevAnswerConfidences, [answerId]: c.confidence };
    return {
      id,
      source_id: mNode,
      target_id: c.id,
      kind: "knowledge",
      // Repeated corroboration across a mentor's answers strengthens the link.
      weight: answerIds.length,
      meta: {
        ...prevMeta,
        sourceType: "mentor",
        mentorProfileId,
        // Typed answers have no media timeline yet (reserved for audio/video).
        timestamps: [],
        // Additive-forward: the edge confidence never drops on a new answer.
        confidence: Math.max(prevConf, c.confidence),
        trade,
        competencyCode: c.competencyCode,
        answerIds,
        answerConfidences,
        model,
        extractedAt,
      },
    };
  });

  // Additive hub edges: connect each concept to its trade topic and any mapped
  // competency (weights re-derived by recomputeKnowledgeAggregates below).
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
  await recomputeKnowledgeAggregates(canonicalIds);
}

/** A queued mentor-concept candidate as returned by the read API. */
export interface KnowledgeCandidateRecord {
  id: string;
  status: string;
  title: string;
  description: string | null;
  category: string;
  trade: string | null;
  confidence: number | null;
  competencyCode: string | null;
  mentorProfileId: string | null;
  mentorName: string | null;
  answerId: string | null;
  sessionId: string | null;
  bestMatches: CandidateMatch[];
  createdAt: string | null;
  resolvedTargetId: string | null;
  resolutionReason: string | null;
  resolvedAt: string | null;
  /** The target the reviewer originally asked for (accept/merge only). */
  requestedTargetId: string | null;
  /** Why the recorded target differs from the requested one (null when it doesn't). */
  redirectReason: string | null;
}

/** Map a raw knowledge_candidates row to the API record shape. */
function mapCandidateRow(row: Record<string, unknown>): KnowledgeCandidateRecord {
  const rawMatches = Array.isArray(row["best_matches"]) ? row["best_matches"] : [];
  const bestMatches: CandidateMatch[] = rawMatches
    .filter((m): m is Record<string, unknown> => typeof m === "object" && m !== null)
    .map((m) => ({
      nodeId: typeof m["nodeId"] === "string" ? m["nodeId"] : "",
      label: typeof m["label"] === "string" ? m["label"] : "",
      similarity: typeof m["similarity"] === "number" ? m["similarity"] : 0,
    }))
    .filter((m) => m.nodeId !== "");
  return {
    id: String(row["id"] ?? ""),
    status: String(row["status"] ?? "pending"),
    title: String(row["title"] ?? ""),
    description: (row["description"] as string | null) ?? null,
    category: String(row["category"] ?? "concept"),
    trade: (row["trade"] as string | null) ?? null,
    confidence: typeof row["confidence"] === "number" ? row["confidence"] : null,
    competencyCode: (row["competency_code"] as string | null) ?? null,
    mentorProfileId: (row["mentor_profile_id"] as string | null) ?? null,
    mentorName: (row["mentor_name"] as string | null) ?? null,
    answerId: (row["answer_id"] as string | null) ?? null,
    sessionId: (row["session_id"] as string | null) ?? null,
    bestMatches,
    createdAt: (row["created_at"] as string | null) ?? null,
    resolvedTargetId: (row["resolved_target_id"] as string | null) ?? null,
    resolutionReason: (row["resolution_reason"] as string | null) ?? null,
    resolvedAt: (row["resolved_at"] as string | null) ?? null,
    requestedTargetId: (row["requested_target_id"] as string | null) ?? null,
    redirectReason: (row["redirect_reason"] as string | null) ?? null,
  };
}

/** Minimal live-graph view used to re-validate review-time targets. */
interface LiveKnowledgeIndex {
  live: Map<string, { id: string; kind: KnowledgeNodeKind; label: string }>;
  /** absorbed identity id → surviving live node id (from node meta.mergedFrom). */
  mergedInto: Map<string, string>;
}

/**
 * One pass over the live knowledge nodes: liveness (id/kind/label) plus the
 * mergedFrom ledger recording which absorbed identities each survivor carries.
 */
async function loadLiveKnowledgeIndex(): Promise<LiveKnowledgeIndex> {
  const { data, error } = await supabase
    .from("knowledge_nodes")
    .select("id, kind, label, meta")
    .in("kind", [...KNOWLEDGE_NODE_KINDS]);
  if (error) throw error;
  const live = new Map<string, { id: string; kind: KnowledgeNodeKind; label: string }>();
  const mergedInto = new Map<string, string>();
  for (const row of data ?? []) {
    const r = row as Record<string, unknown>;
    const id = r["id"] as string;
    live.set(id, {
      id,
      kind: r["kind"] as KnowledgeNodeKind,
      label: (r["label"] as string) || id,
    });
    const meta = (r["meta"] as Record<string, unknown>) ?? {};
    const mergedFrom = Array.isArray(meta["mergedFrom"]) ? meta["mergedFrom"] : [];
    for (const m of mergedFrom) {
      const mid = (m as Record<string, unknown> | null)?.["id"];
      // First writer wins — deterministic even if two survivors claim an id.
      if (typeof mid === "string" && !mergedInto.has(mid)) mergedInto.set(mid, id);
    }
  }
  return { live, mergedInto };
}

/**
 * Follow the mergedFrom redirect chain from a (possibly vanished) node id to
 * its final live survivor. Returns the survivor plus the ids traversed, or
 * null when no chain lands on a live node. Cycle-guarded.
 */
function followMergeChain(
  nodeId: string,
  index: LiveKnowledgeIndex,
): { survivor: { id: string; kind: KnowledgeNodeKind; label: string }; via: string[] } | null {
  const via: string[] = [];
  const seen = new Set<string>([nodeId]);
  let cur = nodeId;
  while (index.mergedInto.has(cur)) {
    const next = index.mergedInto.get(cur)!;
    if (seen.has(next)) return null; // defensive: cyclic ledger
    via.push(cur);
    seen.add(next);
    cur = next;
    const survivor = index.live.get(cur);
    if (survivor) return { survivor, via };
  }
  return null;
}

/** How a review-time target id maps onto the CURRENT live graph. */
export type TargetRevalidation =
  | { state: "live"; targetId: string; label: string; kind: KnowledgeNodeKind }
  | { state: "merged"; targetId: string; label: string; kind: KnowledgeNodeKind; via: string[] }
  | { state: "rematched"; targetId: string; label: string; kind: KnowledgeNodeKind }
  | { state: "gone"; freshMatches: CandidateMatch[] };

/**
 * Re-validate a resolution target against the live graph at decision time.
 * The graph legitimately moves while a candidate sits in review (videos get
 * deleted, mentors withdraw, re-processing collapses nodes), so a recorded
 * best-match id is a HINT, not a guarantee.
 *
 *  1. **live** — the node still exists as-is: use it.
 *  2. **merged** — the id appears in a survivor's meta.mergedFrom ledger:
 *     follow the redirect chain (A→B→C lands on C) and use the survivor.
 *  3. **rematched** — the id is gone without a ledger trail: re-run the SAME
 *     duplicate-smart signals ingestion uses on the candidate's own content
 *     (exact deterministic id → cross-category label+alias index →
 *     same-category semantic ≥ KNOWLEDGE_MATCH_THRESHOLD, with slang/regional
 *     also searching the concept category).
 *  4. **gone** — nothing confidently matches: hand back the CURRENT near
 *     matches (novelty band) so the reviewer can pick a new destination.
 */
export async function revalidateConceptTarget(
  nodeId: string,
  content: { title: string; description: string; category: KnowledgeCategory },
): Promise<TargetRevalidation> {
  const index = await loadLiveKnowledgeIndex();

  // 1. Live as-is.
  const asIs = index.live.get(nodeId);
  if (asIs) return { state: "live", targetId: asIs.id, label: asIs.label, kind: asIs.kind };

  // 2. Merged away — follow the redirect chain to the final survivor.
  const chain = followMergeChain(nodeId, index);
  if (chain) {
    return {
      state: "merged",
      targetId: chain.survivor.id,
      label: chain.survivor.label,
      kind: chain.survivor.kind,
      via: chain.via,
    };
  }

  // 3. Re-match by the candidate's own content — same signals as ingestion.
  const exactId = knowledgeNodeId(content.category, content.title);
  const exact = index.live.get(exactId);
  if (exact) {
    return { state: "rematched", targetId: exact.id, label: exact.label, kind: exact.kind };
  }

  const aliasIndex = await buildKnowledgeAliasIndex();
  const aliasHit = aliasIndex.get(normalizeConcept(content.title));
  if (aliasHit) {
    const hit = index.live.get(aliasHit.id);
    if (hit) return { state: "rematched", targetId: hit.id, label: hit.label, kind: hit.kind };
  }

  const matches: CandidateMatch[] = [];
  const embedding = await createEmbedding(
    conceptEmbeddingText(content.title, content.description),
  );
  if (embedding.length > 0) {
    const categories: KnowledgeCategory[] =
      content.category === "slang" || content.category === "regional_term"
        ? [content.category, "concept"]
        : [content.category];
    for (const cat of categories) {
      const { data, error } = await supabase.rpc("match_knowledge_nodes", {
        query_embedding: embedding,
        filter_category: cat,
        match_threshold: MENTOR_NOVELTY_THRESHOLD,
        match_count: MENTOR_NEIGHBOR_COUNT,
        exclude_ids: [nodeId],
      });
      if (error) throw error;
      for (const m of (data ?? []) as Array<{ id?: string; label?: string; similarity?: number }>) {
        if (typeof m.id === "string" && typeof m.similarity === "number") {
          matches.push({ nodeId: m.id, label: m.label ?? m.id, similarity: m.similarity });
        }
      }
    }
    matches.sort((a, b) => b.similarity - a.similarity);
    const best = matches[0];
    if (best && best.similarity >= KNOWLEDGE_MATCH_THRESHOLD) {
      const hit = index.live.get(best.nodeId);
      if (hit) return { state: "rematched", targetId: hit.id, label: hit.label, kind: hit.kind };
    }
  }

  // 4. Gone — reviewer input required; hand back the current near matches.
  return { state: "gone", freshMatches: matches.slice(0, MENTOR_NEIGHBOR_COUNT) };
}

/**
 * Annotate stored best-matches with their CURRENT validity so reviewers see
 * graph drift before acting: `live` (node still exists), `redirected` (absorbed
 * into a survivor — currentNodeId/currentLabel point at it), or `gone`.
 * One live-graph pass covers the whole listing.
 */
function annotateCandidateMatches(
  records: KnowledgeCandidateRecord[],
  index: LiveKnowledgeIndex,
): void {
  for (const record of records) {
    for (const match of record.bestMatches) {
      const liveNode = index.live.get(match.nodeId);
      if (liveNode) {
        match.validity = "live";
        match.currentNodeId = liveNode.id;
        match.currentLabel = liveNode.label;
        continue;
      }
      const chain = followMergeChain(match.nodeId, index);
      if (chain) {
        match.validity = "redirected";
        match.currentNodeId = chain.survivor.id;
        match.currentLabel = chain.survivor.label;
      } else {
        match.validity = "gone";
        match.currentNodeId = null;
        match.currentLabel = null;
      }
    }
  }
}

/** List queued mentor-concept candidates by status (read-only; default pending). */
export async function listKnowledgeCandidates(
  status: string = "pending",
): Promise<KnowledgeCandidateRecord[]> {
  const { data, error } = await supabase
    .from("knowledge_candidates")
    .select("*")
    .eq("status", status)
    .order("created_at", { ascending: false });
  if (error) throw error;
  const records = (data ?? []).map((row: Record<string, unknown>) => mapCandidateRow(row));
  if (records.some((r) => r.bestMatches.length > 0)) {
    annotateCandidateMatches(records, await loadLiveKnowledgeIndex());
  }
  return records;
}

/**
 * Per-mentor contribution track record — a read-only aggregation reviewers use
 * to gauge how much a mentor has shaped the Living Memory before acting on a
 * borderline candidate. All counts are derived (never persisted), so this is
 * always consistent with the live graph and the candidate history.
 */
export interface MentorContributionStat {
  mentorProfileId: string;
  /** Live concepts this mentor is the ONLY provenance source for. */
  conceptsCreated: number;
  /** Live concepts this mentor co-sources with other videos/mentors. */
  conceptsReinforced: number;
  /** Candidates from this mentor accepted or merged into the graph. */
  accepted: number;
  /** Candidates from this mentor rejected. */
  rejected: number;
  /** Candidates from this mentor still awaiting a decision. */
  pending: number;
}

/**
 * Aggregate each mentor's contribution counts from two read-only sources:
 *
 * 1. **mentor→concept provenance edges** (`knowledge_edges`, kind='knowledge',
 *    source `mentor:<id>`) tell us which live concepts a mentor sources. To split
 *    "created" from "reinforced" we also look at how many DISTINCT provenance
 *    sources each concept has: a concept sourced only by this mentor is counted
 *    as created; a concept it shares with any other video/mentor is reinforced.
 *    This is a proxy — the ingestion-time create/reinforce decision isn't stored
 *    on the edge — but it is well-defined and stable: a concept "created" by a
 *    mentor becomes "reinforced" for everyone once a second source corroborates it.
 * 2. **candidate history** (`knowledge_candidates`) gives each mentor's review
 *    outcomes (accepted/merged → accepted, rejected, pending).
 *
 * A single edge scan and a single candidate scan keep this O(edges + candidates),
 * which is fine at library scale (mirrors the existing listMentors aggregation).
 */
export async function getMentorContributionStats(): Promise<MentorContributionStat[]> {
  const [edgesRes, candsRes] = await Promise.all([
    supabase.from("knowledge_edges").select("source_id, target_id, meta").eq("kind", "knowledge"),
    supabase.from("knowledge_candidates").select("mentor_profile_id, status"),
  ]);
  if (edgesRes.error) throw edgesRes.error;
  if (candsRes.error) throw candsRes.error;

  // concept target id -> set of distinct provenance source node ids
  const conceptSources = new Map<string, Set<string>>();
  // mentor profile id -> set of concept target ids it sources
  const mentorConcepts = new Map<string, Set<string>>();

  for (const row of edgesRes.data ?? []) {
    const e = row as Record<string, unknown>;
    const source = e["source_id"];
    const target = e["target_id"];
    if (typeof source !== "string" || typeof target !== "string") continue;

    let sources = conceptSources.get(target);
    if (!sources) {
      sources = new Set<string>();
      conceptSources.set(target, sources);
    }
    sources.add(source);

    if (source.startsWith("mentor:")) {
      const meta = (e["meta"] as Record<string, unknown> | null) ?? {};
      const pid =
        typeof meta["mentorProfileId"] === "string"
          ? (meta["mentorProfileId"] as string)
          : source.slice("mentor:".length);
      let concepts = mentorConcepts.get(pid);
      if (!concepts) {
        concepts = new Set<string>();
        mentorConcepts.set(pid, concepts);
      }
      concepts.add(target);
    }
  }

  const stats = new Map<string, MentorContributionStat>();
  const ensure = (pid: string): MentorContributionStat => {
    let s = stats.get(pid);
    if (!s) {
      s = {
        mentorProfileId: pid,
        conceptsCreated: 0,
        conceptsReinforced: 0,
        accepted: 0,
        rejected: 0,
        pending: 0,
      };
      stats.set(pid, s);
    }
    return s;
  };

  for (const [pid, concepts] of mentorConcepts) {
    const s = ensure(pid);
    for (const conceptId of concepts) {
      const sources = conceptSources.get(conceptId);
      if (sources && sources.size > 1) s.conceptsReinforced += 1;
      else s.conceptsCreated += 1;
    }
  }

  for (const row of candsRes.data ?? []) {
    const r = row as Record<string, unknown>;
    const pid = r["mentor_profile_id"];
    if (typeof pid !== "string" || !pid) continue;
    const status = r["status"];
    const s = ensure(pid);
    if (status === "accepted" || status === "merged") s.accepted += 1;
    else if (status === "rejected") s.rejected += 1;
    else if (status === "pending") s.pending += 1;
  }

  return [...stats.values()];
}

/** One mentor answer's recorded contribution to a concept's confidence. */
export interface AnswerContributionEntry {
  answerId: string;
  /**
   * Per-answer confidence from the mentor→concept edge ledger
   * (meta.answerConfidences). Null for a legacy edge answer recorded before the
   * ledger existed — reported as-is, never backfilled from the edge max.
   */
  confidence: number | null;
  mentorProfileId: string;
  mentorName: string | null;
  question: string | null;
  answerExcerpt: string | null;
}

const ANSWER_EXCERPT_MAX = 200;

/** Trim a verbatim answer to a short, reviewer-facing excerpt (or null). */
function toAnswerExcerpt(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (!t) return null;
  return t.length > ANSWER_EXCERPT_MAX ? `${t.slice(0, ANSWER_EXCERPT_MAX).trimEnd()}…` : t;
}

/**
 * Read-only: for a mentor-supported concept node, the per-answer confidence each
 * contributing mentor answer recorded on the mentor→concept edge
 * (meta.answerConfidences), joined to the interview answer (question + verbatim
 * excerpt) and mentor profile (name) purely for reviewer-facing identity. NO
 * graph writes. An unknown or non-mentor-supported node yields an empty list.
 *
 * Confidence is reported EXACTLY as the ledger recorded it: an answer present in
 * meta.answerIds but absent from meta.answerConfidences (a legacy edge written
 * before per-answer tracking existed) reports null rather than a backfilled edge
 * max, so the "why is Jack this confident?" story stays honest. Joins tolerate
 * missing rows — a deleted answer/profile yields null fields, not a dropped item.
 */
export async function getConceptAnswerContributions(
  nodeId: string,
): Promise<AnswerContributionEntry[]> {
  const { data: edges, error: edgesErr } = await supabase
    .from("knowledge_edges")
    .select("source_id, meta")
    .eq("target_id", nodeId)
    .eq("kind", "knowledge");
  if (edgesErr) throw edgesErr;

  // answerId -> {confidence, mentorProfileId}. An answer belongs to exactly one
  // mentor (one mentor→concept edge per concept), so a stray duplicate simply
  // keeps the higher recorded confidence.
  const byAnswer = new Map<string, { confidence: number | null; mentorProfileId: string }>();
  for (const row of edges ?? []) {
    const e = row as Record<string, unknown>;
    const source = e["source_id"];
    if (typeof source !== "string" || !source.startsWith("mentor:")) continue;
    const meta = (e["meta"] as Record<string, unknown> | null) ?? {};
    const mentorProfileId =
      typeof meta["mentorProfileId"] === "string"
        ? (meta["mentorProfileId"] as string)
        : source.slice("mentor:".length);
    const answerIds = Array.isArray(meta["answerIds"])
      ? (meta["answerIds"] as unknown[]).filter((a): a is string => typeof a === "string")
      : [];
    const confidences =
      meta["answerConfidences"] && typeof meta["answerConfidences"] === "object"
        ? (meta["answerConfidences"] as Record<string, unknown>)
        : {};
    // Union of answerIds and any recorded confidence keys, so neither a legacy
    // (ledger-less) answer nor a ledger entry that drifted out of answerIds is
    // ever silently dropped.
    const ids = new Set<string>(answerIds);
    for (const k of Object.keys(confidences)) ids.add(k);
    for (const id of ids) {
      const raw = confidences[id];
      const confidence = typeof raw === "number" ? raw : null;
      const prev = byAnswer.get(id);
      if (
        !prev ||
        (confidence !== null && (prev.confidence === null || confidence > prev.confidence))
      ) {
        byAnswer.set(id, { confidence, mentorProfileId });
      }
    }
  }

  if (byAnswer.size === 0) return [];

  // Join verbatim question/answer and mentor names for reviewer-facing identity.
  const { data: answers, error: ansErr } = await supabase
    .from("interview_answers")
    .select("id, question, answer_text, mentor_profile_id")
    .in("id", [...byAnswer.keys()]);
  if (ansErr) throw ansErr;
  const answerById = new Map<string, Record<string, unknown>>();
  for (const a of answers ?? []) {
    const r = a as Record<string, unknown>;
    if (typeof r["id"] === "string") answerById.set(r["id"], r);
  }

  const mentorIds = new Set<string>();
  for (const { mentorProfileId } of byAnswer.values()) mentorIds.add(mentorProfileId);
  for (const a of answerById.values()) {
    const pid = a["mentor_profile_id"];
    if (typeof pid === "string" && pid) mentorIds.add(pid);
  }
  const nameById = new Map<string, string>();
  if (mentorIds.size > 0) {
    const { data: mentors, error: mErr } = await supabase
      .from("mentor_profiles")
      .select("id, name")
      .in("id", [...mentorIds]);
    if (mErr) throw mErr;
    for (const m of mentors ?? []) {
      const r = m as Record<string, unknown>;
      if (typeof r["id"] === "string" && typeof r["name"] === "string") {
        nameById.set(r["id"], r["name"]);
      }
    }
  }

  const contributions: AnswerContributionEntry[] = [];
  for (const [answerId, { confidence, mentorProfileId }] of byAnswer) {
    const answer = answerById.get(answerId);
    const answerMentorId =
      answer && typeof answer["mentor_profile_id"] === "string"
        ? (answer["mentor_profile_id"] as string)
        : mentorProfileId;
    contributions.push({
      answerId,
      confidence,
      mentorProfileId,
      mentorName: nameById.get(answerMentorId) ?? nameById.get(mentorProfileId) ?? null,
      question:
        answer && typeof answer["question"] === "string" ? (answer["question"] as string) : null,
      answerExcerpt: toAnswerExcerpt(answer?.["answer_text"]),
    });
  }

  // Highest-confidence answers first; unknown (legacy null) confidence last.
  contributions.sort((a, b) => {
    if (a.confidence === null && b.confidence === null) return 0;
    if (a.confidence === null) return 1;
    if (b.confidence === null) return -1;
    return b.confidence - a.confidence;
  });

  return contributions;
}

/**
 * Knowledge Review outcomes. accept/merge/reject resolve a PENDING mentor
 * candidate; restore re-mints an ARCHIVED (mentor-withdrawn) concept back into
 * the live graph.
 */
export type CandidateResolutionAction =
  | "accept"
  | "merge"
  | "reject"
  | "restore"
  | "rearchive"
  | "reopen";

export type CandidateResolutionResult =
  | { ok: true; candidate: KnowledgeCandidateRecord; replayed: boolean }
  | { ok: false; code: "not_found" | "conflict" | "invalid"; message: string }
  /** The requested target no longer exists and nothing confidently replaces it —
   * the candidate STAYS pending; bestMatches are fresh near matches for the reviewer. */
  | { ok: false; code: "target_gone"; message: string; bestMatches: CandidateMatch[] };

const CANDIDATE_STATUS_FOR_ACTION: Record<CandidateResolutionAction, string> = {
  accept: "accepted",
  merge: "merged",
  reject: "rejected",
  restore: "restored",
  rearchive: "archived",
  reopen: "pending",
};

/**
 * Resolve a pending knowledge candidate — the Knowledge Review write path.
 *
 * - **accept** reinforces the candidate's top best-match concept exactly like
 *   ingestion-time mentor reinforcement (alias, additive mentor→concept
 *   provenance edge deduped by answerId, aggregate recompute).
 * - **merge** does the same onto a reviewer-chosen existing concept node.
 * - **reject** records the required reason on the row; the graph is untouched.
 *
 * Both graph-writing outcomes route through persistMentorResolvedConcepts — the
 * SAME machinery syncMentorAnswerKnowledge uses — so there is no parallel way of
 * writing mentor knowledge. Replaying a resolution is a no-op: an already-
 * resolved candidate with the same outcome (and target) returns unchanged, and
 * a conflicting re-resolution is refused. The graph write happens BEFORE the
 * status flip, so a mid-flight failure leaves the candidate pending and the
 * retry converges (the underlying writes are idempotent).
 *
 * Concurrency: resolutions for the SAME candidate are serialized through an
 * in-process queue (the API is a single Node process), and the status flip is
 * a compare-and-set (`WHERE status='pending'`), so even a lost race with an
 * external writer can never record two different outcomes — the loser
 * re-reads the row and reports replay/conflict against the winner's outcome.
 */
export async function resolveKnowledgeCandidate(
  candidateId: string,
  action: CandidateResolutionAction,
  opts: { targetNodeId?: string | null; reason?: string | null } = {},
): Promise<CandidateResolutionResult> {
  const prior = resolutionQueues.get(candidateId) ?? Promise.resolve();
  const run = prior.then(
    () => resolveKnowledgeCandidateInner(candidateId, action, opts),
    () => resolveKnowledgeCandidateInner(candidateId, action, opts),
  );
  // Park the chain (errors swallowed for chaining only — the caller still
  // sees them via `run`), and clean up once we're the tail.
  const parked = run.catch(() => undefined);
  resolutionQueues.set(candidateId, parked);
  void parked.finally(() => {
    if (resolutionQueues.get(candidateId) === parked) resolutionQueues.delete(candidateId);
  });
  return run;
}

/** Per-candidate serialization of concurrent resolve requests. */
const resolutionQueues = new Map<string, Promise<unknown>>();

async function resolveKnowledgeCandidateInner(
  candidateId: string,
  action: CandidateResolutionAction,
  opts: { targetNodeId?: string | null; reason?: string | null } = {},
): Promise<CandidateResolutionResult> {
  const { data: row, error } = await supabase
    .from("knowledge_candidates")
    .select("*")
    .eq("id", candidateId)
    .maybeSingle();
  if (error) throw error;
  if (!row) {
    return { ok: false, code: "not_found", message: "No knowledge candidate with that id." };
  }

  const cand = row as Record<string, unknown>;
  const record = mapCandidateRow(cand);

  // Restore has its own lifecycle: it acts on ARCHIVED knowledge (mentor-only
  // concepts demoted out of the graph on withdrawal), re-mints the concept node
  // as attribution-free unverified knowledge, and flips the row to 'restored'.
  // It never touches the pending accept/merge/reject path below.
  if (action === "restore") {
    return restoreArchivedCandidateInner(record);
  }

  // Re-archive is the inverse of restore: it undoes a reviewer restore, demoting
  // the curated concept back to an archived candidate. Like restore it acts on
  // its own lifecycle (a 'restored' row) and never touches the pending path.
  if (action === "rearchive") {
    return rearchiveRestoredCandidateInner(record);
  }

  // Reopen is a reviewer's undo for a RESOLVED candidate: a rejected row flips
  // back to 'pending' side-effect-free (reject wrote no graph edge), while an
  // accepted/merged row also has its reinforcement reversed per-answer before the
  // flip. It has its own lifecycle and never touches the accept/merge write path.
  if (action === "reopen") {
    return reopenResolvedCandidateInner(record);
  }

  const nextStatus = CANDIDATE_STATUS_FOR_ACTION[action];

  // Validate the action's inputs before touching anything.
  let targetNodeId: string | null = null;
  let reason: string | null = null;
  if (action === "accept") {
    targetNodeId = record.bestMatches[0]?.nodeId ?? null;
    if (!targetNodeId) {
      return {
        ok: false,
        code: "invalid",
        message: "This candidate has no recorded best match to accept — use merge with a target.",
      };
    }
  } else if (action === "merge") {
    targetNodeId = opts.targetNodeId?.trim() || null;
    if (!targetNodeId) {
      return { ok: false, code: "invalid", message: "Merge requires a target concept." };
    }
  } else {
    reason = opts.reason?.trim() || null;
    if (!reason) {
      return { ok: false, code: "invalid", message: "Reject requires a reason." };
    }
  }

  // Idempotent replay: same outcome (and same target for accept/merge) is a
  // no-op; a different outcome on a resolved candidate is a conflict. A
  // resolution recorded via redirect still replays cleanly: the reviewer's
  // requested target is stored alongside the actual one, and matching EITHER
  // counts as the same outcome.
  if (record.status !== "pending") {
    const sameOutcome =
      record.status === nextStatus &&
      (action === "reject" ||
        record.resolvedTargetId === targetNodeId ||
        record.requestedTargetId === targetNodeId);
    if (sameOutcome) return { ok: true, candidate: record, replayed: true };
    return {
      ok: false,
      code: "conflict",
      message: `Candidate was already resolved as '${record.status}'.`,
    };
  }

  // The reviewer's requested target vs. what the live graph resolves it to.
  let actualTargetId: string | null = null;
  let redirectReason: string | null = null;

  if (action !== "reject") {
    // A target that EXISTS but is a scaffold node (core/topic/competency/
    // video/mentor) is reviewer error, not graph drift — refuse it outright
    // rather than letting content re-matching paper over it.
    const { data: rawTarget, error: tErr } = await supabase
      .from("knowledge_nodes")
      .select("id, kind")
      .eq("id", targetNodeId!)
      .maybeSingle();
    if (tErr) throw tErr;
    const raw = rawTarget as Record<string, unknown> | null;
    if (raw && !KNOWLEDGE_NODE_KINDS.includes(raw["kind"] as KnowledgeNodeKind)) {
      return {
        ok: false,
        code: "invalid",
        message: "Target must be an existing distilled concept node.",
      };
    }

    if (!record.mentorProfileId) {
      return {
        ok: false,
        code: "invalid",
        message: "Candidate has no mentor provenance to preserve.",
      };
    }

    const category = record.category as KnowledgeCategory;

    // Re-validate the target against the live graph INSIDE the serialized
    // section — the graph may have moved while the candidate sat in review
    // (video deletion, mentor withdrawal, re-processing merges).
    const revalidation = await revalidateConceptTarget(targetNodeId!, {
      title: record.title,
      description: record.description ?? "",
      category,
    });
    if (revalidation.state === "gone") {
      return {
        ok: false,
        code: "target_gone",
        message:
          "The chosen concept no longer exists in the knowledge graph and nothing " +
          "confidently replaces it — pick a new destination.",
        bestMatches: revalidation.freshMatches,
      };
    }
    actualTargetId = revalidation.targetId;
    redirectReason =
      revalidation.state === "merged"
        ? `Requested concept was merged into “${revalidation.label}”.`
        : revalidation.state === "rematched"
          ? `Requested concept no longer exists; re-matched by content to “${revalidation.label}”.`
          : null;

    const itemId = knowledgeNodeId(category, record.title);
    const targetLabel = revalidation.label || actualTargetId;
    const resolvedConcept: MentorResolvedConcept = {
      id: actualTargetId,
      // Keep the target node's own kind — a slang candidate merged into a
      // concept node must not re-kind the concept.
      category: revalidation.kind as KnowledgeCategory,
      title: record.title,
      description: record.description ?? "",
      timestamps: [],
      confidence: record.confidence ?? 0.6,
      competencyCode: record.competencyCode,
      // The target owns its embedding; the candidate never brings one in.
      embeddingJson: null,
      mergedFrom:
        itemId !== actualTargetId
          ? [{ id: itemId, label: record.title, category }]
          : [],
      reinforced: true,
      matchedLabel: targetLabel,
      // Record the mentor's wording as an alias when it differs from the label
      // (persistMentorResolvedConcepts dedups against existing aliases).
      newAliases:
        normalizeConcept(record.title) !== normalizeConcept(targetLabel) ? [record.title] : [],
    };

    await ensureMentorNode(record.mentorProfileId, record.mentorName ?? "Mentor", record.trade);
    await persistMentorResolvedConcepts(record.mentorProfileId, [resolvedConcept], {
      // Dedup key for the mentor→concept provenance edge: the original answer
      // when known, otherwise the candidate id (still deterministic per item).
      answerId: record.answerId ?? record.id,
      trade: record.trade,
      model: null,
      extractedAt: new Date().toISOString(),
    });
  }

  const now = new Date().toISOString();
  // Compare-and-set: only flip the status if the row is still pending. If an
  // external writer resolved it in the meantime, re-read and report the
  // winner's outcome as replay (same) or conflict (different).
  const { data: updated, error: updErr } = await supabase
    .from("knowledge_candidates")
    .update({
      status: nextStatus,
      resolved_target_id: action === "reject" ? null : actualTargetId,
      requested_target_id: action === "reject" ? null : targetNodeId,
      redirect_reason: action === "reject" ? null : redirectReason,
      resolution_reason: action === "reject" ? reason : null,
      resolved_at: now,
      updated_at: now,
    })
    .eq("id", candidateId)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();
  if (updErr) throw updErr;

  if (!updated) {
    const { data: current, error: curErr } = await supabase
      .from("knowledge_candidates")
      .select("*")
      .eq("id", candidateId)
      .maybeSingle();
    if (curErr) throw curErr;
    if (!current) {
      return { ok: false, code: "not_found", message: "No knowledge candidate with that id." };
    }
    const winner = mapCandidateRow(current as Record<string, unknown>);
    const sameOutcome =
      winner.status === nextStatus &&
      (action === "reject" ||
        winner.resolvedTargetId === targetNodeId ||
        winner.requestedTargetId === targetNodeId);
    if (sameOutcome) return { ok: true, candidate: winner, replayed: true };
    return {
      ok: false,
      code: "conflict",
      message: `Candidate was already resolved as '${winner.status}'.`,
    };
  }

  return { ok: true, candidate: mapCandidateRow(updated as Record<string, unknown>), replayed: false };
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

/** What removeMentorGraph did to the concepts the withdrawn mentor touched. */
export interface MentorGraphRemoval {
  /** Concepts that survive on other evidence (videos / other mentors). */
  retainedConceptIds: string[];
  /** Mentor-only concepts demoted to `archived` knowledge_candidates rows. */
  archivedConceptIds: string[];
}

/**
 * Remove a withdrawn mentor's graph footprint — the counterpart to
 * removeVideoGraph, but re-evaluated concept by concept instead of blindly
 * pruned. Withdrawal removes the PERSON, not the community's corroborated
 * knowledge:
 *
 *  - A concept with surviving evidence (source videos or other mentors) is
 *    RETAINED; its aggregates are recomputed from the remaining provenance so
 *    confidence/sourceCount/timestamps/hub-edge weights honestly drop — the
 *    same automatic reduction video deletion already gets.
 *  - A concept resting SOLELY on the withdrawn mentor is not silently
 *    hard-deleted: it is demoted OUT of the live graph into an `archived`
 *    knowledge_candidates row (deterministic `arch:<nodeId>` id, inserted with
 *    ignoreDuplicates so replays converge; attribution-free content snapshot
 *    only), preserving the concept text for potential future review with no
 *    link back to the mentor.
 *  - Reviewer verification (verified/rejected + verificationHistory) survives
 *    untouched on retained concepts. A `mentor_supplied` status that rested
 *    solely on this mentor is recomputed from surviving evidence: with no
 *    mentor provenance left it falls back to 'unverified' (a system-derived
 *    status change, like ingestion setting it — no history entry is appended,
 *    since verificationHistory records human decisions only).
 *  - Aliases on retained concepts STAY (deliberate): aliases are unattributed
 *    alternate wordings of the concept, not mentor data — removing them would
 *    break duplicate-matching for every other source that taught the wording.
 *
 * The archive write happens BEFORE any deletion so a mid-flight failure never
 * loses concept content; every step is idempotent, so a retry converges.
 */
export async function removeMentorGraph(profileId: string): Promise<MentorGraphRemoval> {
  const mNode = mentorNodeId(profileId);

  // Concepts this mentor corroborates, captured before the node (and, by
  // cascade, its provenance edges) is deleted.
  const affected = await provenanceTargetsForVideo(mNode);

  // Partition: which affected concepts still have provenance from OTHER sources?
  let retained: string[] = [];
  let orphaned: string[] = [];
  if (affected.length > 0) {
    const { data, error } = await supabase
      .from("knowledge_edges")
      .select("source_id, target_id")
      .eq("kind", "knowledge")
      .in("target_id", affected);
    if (error) throw error;
    const otherSourced = new Set<string>();
    for (const e of data ?? []) {
      const src = (e as Record<string, unknown>)["source_id"] as string;
      const tgt = (e as Record<string, unknown>)["target_id"] as string;
      if (src !== mNode) otherSourced.add(tgt);
    }
    retained = affected.filter((id) => otherSourced.has(id));
    orphaned = affected.filter((id) => !otherSourced.has(id));
  }

  // Demote mentor-only concepts to archived candidates BEFORE deleting anything,
  // so a mid-flight failure is retryable without losing the concept content.
  if (orphaned.length > 0) {
    await archiveOrphanedConcepts(orphaned);
    const { error } = await supabase.from("knowledge_nodes").delete().in("id", orphaned);
    if (error) throw error;
  }

  // Remove the mentor source node; its provenance + hub edges cascade away.
  const { error: mErr } = await supabase.from("knowledge_nodes").delete().eq("id", mNode);
  if (mErr) throw mErr;

  // A trade hub anchored only by this mentor loses its reason to exist; the
  // knowledge prune is a safety net (retained concepts all have other sources).
  await pruneOrphanTopics();
  await pruneOrphanKnowledge();

  // Reconverge the survivors from their remaining provenance edges.
  await recomputeKnowledgeAggregates(retained);
  await demoteStaleMentorSupplied(retained);

  return { retainedConceptIds: retained, archivedConceptIds: orphaned };
}

/**
 * Snapshot mentor-only concept nodes into `archived` knowledge_candidates rows.
 * The snapshot is attribution-FREE by construction: label, description,
 * category, trade, confidence, competency code, and aliases — never a mentor
 * profile/name/answer/session. The deterministic `arch:<nodeId>` id plus
 * ignoreDuplicates makes replays converge without duplicating or resetting.
 */
async function archiveOrphanedConcepts(conceptIds: string[]): Promise<void> {
  if (conceptIds.length === 0) return;
  const [nodesRes, hubRes] = await Promise.all([
    supabase
      .from("knowledge_nodes")
      .select("id, kind, label, trade, description, confidence, meta")
      .in("id", conceptIds),
    supabase
      .from("knowledge_edges")
      .select("source_id, target_id")
      .in("source_id", conceptIds)
      .eq("kind", "competency"),
  ]);
  if (nodesRes.error) throw nodesRes.error;
  if (hubRes.error) throw hubRes.error;

  // First mapped competency code per concept (from its hub edges), if any.
  const compByConcept = new Map<string, string>();
  for (const e of hubRes.data ?? []) {
    const src = (e as Record<string, unknown>)["source_id"] as string;
    const tgt = (e as Record<string, unknown>)["target_id"] as string;
    if (tgt.startsWith("comp:") && !compByConcept.has(src)) {
      compByConcept.set(src, tgt.slice("comp:".length));
    }
  }

  const rows = (nodesRes.data ?? []).map((row) => {
    const n = row as Record<string, unknown>;
    const id = n["id"] as string;
    const meta = (n["meta"] as Record<string, unknown>) ?? {};
    return {
      id: `arch:${id}`,
      status: "archived",
      title: n["label"] as string,
      description: (n["description"] as string | null) ?? null,
      category: n["kind"] as string,
      trade: (n["trade"] as string | null) ?? null,
      confidence: typeof n["confidence"] === "number" ? (n["confidence"] as number) : null,
      competency_code: compByConcept.get(id) ?? null,
      mentor_profile_id: null,
      mentor_name: null,
      answer_id: null,
      session_id: null,
      best_matches: [],
      aliases: metaAliases(meta),
    };
  });

  const { error } = await supabase
    .from("knowledge_candidates")
    .upsert(rows, { onConflict: "id", ignoreDuplicates: true });
  if (error) throw error;
}

/**
 * Restore a previously ARCHIVED concept — the inverse of archiveOrphanedConcepts
 * and the Knowledge Review "restore" write path. An archived row is a mentor-
 * only concept that was demoted OUT of the live graph on mentor withdrawal
 * (attribution-free `arch:<nodeId>` snapshot). Restoring re-mints it as
 * attribution-free, UNVERIFIED curated knowledge:
 *
 *  - The node id is recovered from the `arch:<nodeId>` candidate id, so a
 *    restore lands on the SAME deterministic node the concept had before
 *    withdrawal. A video/mentor that re-taught the concept meanwhile is
 *    REINFORCED, not clobbered (label/trade first-writer-wins; a human
 *    verify/reject decision survives).
 *  - The node carries `meta.curated` so pruneOrphanKnowledge keeps it despite
 *    having no source-provenance edge (it is intentionally sourceless — the
 *    reviewer, not a video or mentor, vouches for it).
 *  - Replay-safe like the pending resolutions: the graph write happens BEFORE
 *    the status flip (a mid-flight failure leaves the row 'archived' and a
 *    retry re-mints idempotently), and the flip is compare-and-set on
 *    `status='archived'` so an already-'restored' row is a no-op success.
 */
async function restoreArchivedCandidateInner(
  record: KnowledgeCandidateRecord,
): Promise<CandidateResolutionResult> {
  // Replay: an already-restored candidate is a no-op success.
  if (record.status === "restored") {
    return { ok: true, candidate: record, replayed: true };
  }
  // Only archived knowledge can be restored — refuse any other lifecycle state.
  if (record.status !== "archived") {
    return {
      ok: false,
      code: "conflict",
      message: `Only archived knowledge can be restored (this candidate is '${record.status}').`,
    };
  }

  // Recover the original deterministic concept id from the arch:<nodeId> row id.
  const nodeId = record.id.startsWith("arch:") ? record.id.slice("arch:".length) : "";
  if (!nodeId.startsWith("k:")) {
    return {
      ok: false,
      code: "invalid",
      message: "This archived record has no recoverable concept id to restore.",
    };
  }

  // Graph write BEFORE the status flip so a mid-flight failure is retryable.
  await restoreConceptNode(nodeId, record);

  const now = new Date().toISOString();
  const { data: updated, error: updErr } = await supabase
    .from("knowledge_candidates")
    .update({
      status: "restored",
      resolved_target_id: nodeId,
      resolved_at: now,
      updated_at: now,
    })
    .eq("id", record.id)
    .eq("status", "archived")
    .select("*")
    .maybeSingle();
  if (updErr) throw updErr;

  if (!updated) {
    // Lost the compare-and-set race — re-read and report replay/conflict.
    const { data: current, error: curErr } = await supabase
      .from("knowledge_candidates")
      .select("*")
      .eq("id", record.id)
      .maybeSingle();
    if (curErr) throw curErr;
    if (!current) {
      return { ok: false, code: "not_found", message: "No knowledge candidate with that id." };
    }
    const winner = mapCandidateRow(current as Record<string, unknown>);
    if (winner.status === "restored") return { ok: true, candidate: winner, replayed: true };
    return {
      ok: false,
      code: "conflict",
      message: `Candidate was already resolved as '${winner.status}'.`,
    };
  }

  return { ok: true, candidate: mapCandidateRow(updated as Record<string, unknown>), replayed: false };
}

/**
 * Undo a reviewer restore — the inverse of restoreArchivedCandidateInner. A
 * concept restored by mistake stays in the live graph as a curated node; this
 * demotes it back to an `archived` candidate so reviewers have full control over
 * withdrawn-mentor knowledge:
 *
 *  - The concept node is re-evaluated like a mentor withdrawal: if a video or
 *    mentor re-taught it AFTER the restore (a live `knowledge` provenance edge
 *    exists), the node SURVIVES on that evidence — only the reviewer's curated
 *    vouch is dropped (`meta.curated`/`restoredAt` cleared, aggregates + any
 *    stale `mentor_supplied` status recomputed). Otherwise it is a sourceless
 *    curated node and re-archiving means removing it from the live graph; the
 *    `arch:<nodeId>` candidate row still preserves its content snapshot.
 *  - Replay-safe like the other resolutions: the graph write happens BEFORE the
 *    status flip (a mid-flight failure leaves the row 'restored' and a retry
 *    converges — every step is idempotent), and the flip is compare-and-set on
 *    `status='restored'` so an already-'archived' row is a no-op success. Pairs
 *    with restore as a toggle: each action is a no-op on its own end state.
 */
async function rearchiveRestoredCandidateInner(
  record: KnowledgeCandidateRecord,
): Promise<CandidateResolutionResult> {
  // Replay: an already-archived candidate is a no-op success.
  if (record.status === "archived") {
    return { ok: true, candidate: record, replayed: true };
  }
  // Only restored knowledge can be re-archived — refuse any other lifecycle state.
  if (record.status !== "restored") {
    return {
      ok: false,
      code: "conflict",
      message: `Only restored knowledge can be re-archived (this candidate is '${record.status}').`,
    };
  }

  // Recover the original deterministic concept id from the arch:<nodeId> row id.
  const nodeId = record.id.startsWith("arch:") ? record.id.slice("arch:".length) : "";
  if (!nodeId.startsWith("k:")) {
    return {
      ok: false,
      code: "invalid",
      message: "This record has no recoverable concept id to re-archive.",
    };
  }

  // Graph write BEFORE the status flip so a mid-flight failure is retryable.
  await rearchiveConceptNode(nodeId);

  const now = new Date().toISOString();
  const { data: updated, error: updErr } = await supabase
    .from("knowledge_candidates")
    .update({
      status: "archived",
      resolved_target_id: null,
      resolved_at: null,
      updated_at: now,
    })
    .eq("id", record.id)
    .eq("status", "restored")
    .select("*")
    .maybeSingle();
  if (updErr) throw updErr;

  if (!updated) {
    // Lost the compare-and-set race — re-read and report replay/conflict.
    const { data: current, error: curErr } = await supabase
      .from("knowledge_candidates")
      .select("*")
      .eq("id", record.id)
      .maybeSingle();
    if (curErr) throw curErr;
    if (!current) {
      return { ok: false, code: "not_found", message: "No knowledge candidate with that id." };
    }
    const winner = mapCandidateRow(current as Record<string, unknown>);
    if (winner.status === "archived") return { ok: true, candidate: winner, replayed: true };
    return {
      ok: false,
      code: "conflict",
      message: `Candidate was already resolved as '${winner.status}'.`,
    };
  }

  return { ok: true, candidate: mapCandidateRow(updated as Record<string, unknown>), replayed: false };
}

/**
 * Per-answer inverse of persistMentorResolvedConcepts' provenance write: drop a
 * single answer's contribution to a mentor→concept edge, then re-evaluate the
 * concept. This is what lets `reopen` undo an accepted/merged lesson.
 *
 *  - Remove `answerId` from the mentor→concept edge's `meta.answerIds`
 *    (weight = distinct answers), deleting the edge only when its LAST answer
 *    leaves — so a concept the mentor corroborated across several answers keeps the
 *    edge minus this one. Removing an already-absent answer, or acting on an
 *    edge/target that has since vanished, is a no-op — the reversal is idempotent
 *    and safe to run before the reopen status flip (a mid-flight failure heals on
 *    a reopen retry).
 *  - Then prune (a now-sourceless, non-curated concept is deleted, edges cascade),
 *    recompute the survivor's aggregates so confidence (noisy-OR over the
 *    REMAINING sources) and hub-edge weights drop honestly, and demote a
 *    solely-mentor-supplied verification status back to 'unverified' — the SAME
 *    re-evaluation a mentor withdrawal runs on a corroborated concept.
 *  - Aliases and `meta.mergedFrom` are deliberately LEFT intact (they are
 *    unattributed alternate wordings, not mentor data — dropping them would break
 *    duplicate-matching for every other source; the retained alias means a
 *    re-taught wording exact-alias-matches back into the reinforce band).
 *  - The edge's scalar `meta.confidence` is recomputed as the max over the
 *    SURVIVING answers' per-answer confidence (`meta.answerConfidences`), so a
 *    withdrawn high-confidence answer no longer leaves the edge over-confident.
 *    A legacy edge written before the per-answer ledger existed keeps its prior
 *    confidence when a surviving answer's value is unknown — never understated.
 */
async function reverseMentorReinforcement(
  mentorProfileId: string,
  targetNodeId: string | null,
  answerId: string,
): Promise<void> {
  // A resolved accept/merge always recorded its target; without one there is
  // nothing to reverse.
  if (!targetNodeId) return;

  const edgeId = edgeKey(mentorNodeId(mentorProfileId), targetNodeId);
  const { data: edgeRow, error } = await supabase
    .from("knowledge_edges")
    .select("id, meta")
    .eq("id", edgeId)
    .maybeSingle();
  if (error) throw error;

  if (edgeRow) {
    const meta = ((edgeRow as Record<string, unknown>)["meta"] as Record<string, unknown>) ?? {};
    const prevAnswerIds = Array.isArray(meta["answerIds"])
      ? (meta["answerIds"] as unknown[]).filter((a): a is string => typeof a === "string")
      : [];
    // Only touch the edge when this answer actually contributed to it — otherwise
    // the reversal already happened (idempotent retry) and we must not disturb
    // another answer's corroboration.
    if (prevAnswerIds.includes(answerId)) {
      const answerIds = prevAnswerIds.filter((a) => a !== answerId);
      if (answerIds.length === 0) {
        // This answer was the mentor's only corroboration — drop the edge entirely.
        const { error: delErr } = await supabase
          .from("knowledge_edges")
          .delete()
          .eq("id", edgeId);
        if (delErr) throw delErr;
      } else {
        // Other answers still corroborate — keep the edge, minus this answer.
        // Recompute the edge confidence as the max over the SURVIVING answers'
        // recorded per-answer confidence, so withdrawing a high-confidence answer
        // no longer leaves the edge over-confident. A legacy edge (written before
        // the per-answer ledger) with any surviving answer whose confidence we do
        // not know is left at its existing confidence — never understated.
        const prevAnswerConfidences =
          meta["answerConfidences"] && typeof meta["answerConfidences"] === "object"
            ? (meta["answerConfidences"] as Record<string, number>)
            : {};
        const answerConfidences: Record<string, number> = {};
        for (const id of answerIds) {
          if (typeof prevAnswerConfidences[id] === "number") {
            answerConfidences[id] = prevAnswerConfidences[id];
          }
        }
        const prevConf = typeof meta["confidence"] === "number" ? (meta["confidence"] as number) : 0;
        const haveAllSurviving = answerIds.every(
          (id) => typeof prevAnswerConfidences[id] === "number",
        );
        const confidence = haveAllSurviving
          ? Math.max(...answerIds.map((id) => prevAnswerConfidences[id] as number))
          : prevConf;
        // (knowledge_edges has no updated_at column; only weight + meta change.)
        const { error: updErr } = await supabase
          .from("knowledge_edges")
          .update({
            weight: answerIds.length,
            meta: { ...meta, answerIds, answerConfidences, confidence },
          })
          .eq("id", edgeId);
        if (updErr) throw updErr;
      }
    }
  }

  // Re-evaluate the concept from its REMAINING provenance: drop it if now
  // sourceless (curated nodes exempt), else reconverge its aggregates and demote a
  // stale mentor_supplied status. Prune before recompute — recompute skips ids that
  // no longer exist — mirroring removeVideoGraph / removeMentorGraph.
  await pruneOrphanKnowledge();
  await recomputeKnowledgeAggregates([targetNodeId]);
  await demoteStaleMentorSupplied([targetNodeId]);
}

/**
 * Reopen a RESOLVED candidate — a reviewer's undo that returns it to the pending
 * queue for a fresh accept/merge/reject decision:
 *
 *  - REJECTED rows: reject wrote NO graph edge, so clearing the resolution fields
 *    and flipping back to 'pending' is completely side-effect-free.
 *  - ACCEPTED / MERGED rows: accept/merge wrote an additive mentor→concept
 *    provenance edge. Reopen reverses it PER-ANSWER (reverseMentorReinforcement)
 *    before the flip, so confidence, hub-edge weights and a solely-mentor-supplied
 *    verification status all drop honestly — undoing the lesson, not just the row.
 *  - A withdrawn mentor's resolved candidate is SCRUBBED (mentor_profile_id
 *    nulled). Reopening such a row would strand it: accept/merge later refuse a
 *    candidate with no mentor provenance, and a future withdrawal would DELETE a
 *    pending row rather than scrub it. So reopen refuses a scrubbed row up front.
 *  - Replay-safe and toggle-shaped like restore/rearchive: the graph reversal
 *    runs BEFORE the compare-and-set flip and every step is idempotent, so an
 *    already-'pending' row is a no-op success, a mid-flight failure heals on a
 *    reopen retry, and a row resolved out from under us reports replay/conflict.
 */
async function reopenResolvedCandidateInner(
  record: KnowledgeCandidateRecord,
): Promise<CandidateResolutionResult> {
  // Replay: an already-pending candidate is a no-op success.
  if (record.status === "pending") {
    return { ok: true, candidate: record, replayed: true };
  }
  // Only a resolved candidate can be reopened — refuse any other lifecycle state
  // (archived/restored have their own restore/rearchive inverse).
  if (
    record.status !== "rejected" &&
    record.status !== "accepted" &&
    record.status !== "merged"
  ) {
    return {
      ok: false,
      code: "conflict",
      message: `Only rejected, accepted, or merged candidates can be reopened (this candidate is '${record.status}').`,
    };
  }
  // A withdrawn mentor's candidate was scrubbed of its provenance — reopening it
  // would strand it (accept/merge would forever refuse it), so refuse up front.
  if (!record.mentorProfileId) {
    return {
      ok: false,
      code: "invalid",
      message:
        "This candidate's mentor was withdrawn, so it can no longer be reopened for reinforcement.",
    };
  }

  // Accept/merge wrote a mentor→concept provenance edge; undo this answer's
  // contribution BEFORE the status flip so a mid-flight failure heals on retry.
  // (A rejected row wrote no edge and skips this entirely.)
  if (record.status === "accepted" || record.status === "merged") {
    await reverseMentorReinforcement(
      record.mentorProfileId,
      record.resolvedTargetId,
      // Same dedup key persistMentorResolvedConcepts used: the original answer
      // when known, otherwise the candidate id.
      record.answerId ?? record.id,
    );
  }

  const now = new Date().toISOString();
  // Compare-and-set: only reopen if the row is still in the state we reversed.
  // Clear every resolution field so the row is indistinguishable from a fresh
  // pending candidate for the accept/merge/reject path.
  const { data: updated, error: updErr } = await supabase
    .from("knowledge_candidates")
    .update({
      status: "pending",
      resolution_reason: null,
      resolved_target_id: null,
      requested_target_id: null,
      redirect_reason: null,
      resolved_at: null,
      updated_at: now,
    })
    .eq("id", record.id)
    .eq("status", record.status)
    // Guard the scrub race too: if a mentor withdrawal nulls this row's
    // provenance between the pre-read check above and here, the CAS misses and
    // we never strand it as pending. (fake-supabase models only this .not form.)
    .not("mentor_profile_id", "is", null)
    .select("*")
    .maybeSingle();
  if (updErr) throw updErr;

  if (!updated) {
    // Lost the compare-and-set race — re-read and report replay/conflict/invalid.
    const { data: current, error: curErr } = await supabase
      .from("knowledge_candidates")
      .select("*")
      .eq("id", record.id)
      .maybeSingle();
    if (curErr) throw curErr;
    if (!current) {
      return { ok: false, code: "not_found", message: "No knowledge candidate with that id." };
    }
    const winner = mapCandidateRow(current as Record<string, unknown>);
    if (winner.status === "pending") return { ok: true, candidate: winner, replayed: true };
    // Scrubbed out from under us (still resolved but mentor now null) — report the
    // same strand refusal the pre-read guard would give on retry.
    if (winner.status === record.status && !winner.mentorProfileId) {
      return {
        ok: false,
        code: "invalid",
        message:
          "This candidate's mentor was withdrawn, so it can no longer be reopened for reinforcement.",
      };
    }
    return {
      ok: false,
      code: "conflict",
      message: `Candidate was already resolved as '${winner.status}'.`,
    };
  }

  return { ok: true, candidate: mapCandidateRow(updated as Record<string, unknown>), replayed: false };
}

/**
 * Demote a restored concept node out of its curated state — the graph half of
 * re-archiving. If the node has gained real provenance since the restore it is
 * KEPT (only its curated flag is dropped and aggregates recomputed); a still-
 * sourceless curated node is deleted outright (edges cascade via the foreign
 * key; the archived candidate row preserves the content). Idempotent: a node
 * already gone or already un-curated converges on a retry.
 */
async function rearchiveConceptNode(nodeId: string): Promise<void> {
  // Does a video/mentor re-teach this concept? A surviving `knowledge`
  // provenance edge means the node stands on its own evidence now.
  const { data: provEdges, error: provErr } = await supabase
    .from("knowledge_edges")
    .select("source_id")
    .eq("kind", "knowledge")
    .eq("target_id", nodeId);
  if (provErr) throw provErr;
  const hasSource = (provEdges ?? []).length > 0;

  if (hasSource) {
    // Retain: drop only the reviewer's curated vouch, then reconverge the node
    // from its surviving provenance (like a mentor withdrawal on a corroborated
    // concept).
    const { data: nodeRow, error } = await supabase
      .from("knowledge_nodes")
      .select("meta")
      .eq("id", nodeId)
      .maybeSingle();
    if (error) throw error;
    if (nodeRow) {
      const meta = {
        ...(((nodeRow as Record<string, unknown>)["meta"] as Record<string, unknown>) ?? {}),
      };
      delete meta["curated"];
      delete meta["restoredAt"];
      const { error: updErr } = await supabase
        .from("knowledge_nodes")
        .update({ meta, updated_at: new Date().toISOString() })
        .eq("id", nodeId);
      if (updErr) throw updErr;
    }
    await recomputeKnowledgeAggregates([nodeId]);
    await demoteStaleMentorSupplied([nodeId]);
    return;
  }

  // Sourceless curated node: remove it from the live graph. Its hub edges
  // cascade with the node delete; the arch:<nodeId> candidate row keeps the
  // content snapshot. A trade hub left anchoring nothing is pruned.
  const { error: delErr } = await supabase.from("knowledge_nodes").delete().eq("id", nodeId);
  if (delErr) throw delErr;
  await pruneOrphanTopics();
}

/**
 * Re-mint a single archived concept node into the live graph as attribution-free
 * unverified curated knowledge, wired to its trade topic (and any recorded
 * competency) hub. Idempotent: an existing node keeps its identity and any human
 * verification decision; a fresh restore is reborn with the archived snapshot's
 * confidence rather than at zero. `meta.curated` is what keeps a sourceless
 * restored node alive through pruneOrphanKnowledge.
 */
async function restoreConceptNode(
  nodeId: string,
  record: KnowledgeCandidateRecord,
): Promise<void> {
  const now = new Date().toISOString();
  const { data: prevRow, error } = await supabase
    .from("knowledge_nodes")
    .select("id, kind, label, trade, description, confidence, verification_status, meta")
    .eq("id", nodeId)
    .maybeSingle();
  if (error) throw error;
  const prev = prevRow as Record<string, unknown> | null;

  const prevMeta = (prev?.["meta"] as Record<string, unknown>) ?? {};
  const kind = (prev?.["kind"] as string) || record.category;
  const label = (prev?.["label"] as string) || record.title;
  const trade = (prev?.["trade"] as string | null) ?? record.trade;

  const prevDesc = (prev?.["description"] as string | null) ?? "";
  const recDesc = record.description ?? "";
  const description = recDesc.length > prevDesc.length ? recDesc : prevDesc || recDesc;

  // Keep an already-re-sourced confidence; a fresh restore uses the archived
  // snapshot's value so the concept isn't reborn at zero.
  const confidence =
    typeof prev?.["confidence"] === "number" ? (prev["confidence"] as number) : record.confidence;

  // Preserve a human decision; otherwise a restored concept is unverified.
  const prevStatus = (prev?.["verification_status"] as string | null) ?? null;
  const verification =
    prevStatus === "verified" || prevStatus === "rejected" ? prevStatus : "unverified";

  const aliases = growAliases(
    label,
    prevMeta,
    normalizeConcept(record.title) === normalizeConcept(label) ? [] : [record.title],
  );

  await ensureCompetencyNodes(record.competencyCode ? [record.competencyCode] : []);

  // Scaffold the concept node plus its trade hub. The topic hub is minted here
  // (consistent with how ingestion scaffolds hubs in writeVideoNode) so that a
  // restore whose trade hub was never created or was pruned can't 500 on the
  // concept→topic foreign key. Its own scaffold columns are omitted so this
  // never clobbers a live hub's fields on conflict.
  const scaffoldNodes: NodeUpsert[] = [
    {
      id: nodeId,
      kind,
      label,
      trade,
      ref_id: nodeId,
      description: description || null,
      confidence,
      verification_status: verification,
      meta: {
        ...prevMeta,
        category: (prevMeta["category"] as string) || record.category,
        aliases,
        // Reviewer-vouched, source-free: survives pruneOrphanKnowledge.
        curated: true,
        restoredAt: (prevMeta["restoredAt"] as string) || now,
      },
    },
  ];
  if (trade) {
    scaffoldNodes.push({ id: topicNodeId(trade), kind: "topic", label: trade, trade });
  }
  await upsertNodes(scaffoldNodes);

  const hubEdges: EdgeUpsert[] = [];
  if (trade) {
    // Keep the hub wired to the core so a freshly-minted hub isn't orphaned.
    hubEdges.push({
      id: edgeKey(GRAPH_CORE_ID, topicNodeId(trade)),
      source_id: GRAPH_CORE_ID,
      target_id: topicNodeId(trade),
      kind: "topic",
    });
    hubEdges.push({
      id: edgeKey(nodeId, topicNodeId(trade)),
      source_id: nodeId,
      target_id: topicNodeId(trade),
      kind: "topic",
      weight: 1,
    });
  }
  if (record.competencyCode) {
    hubEdges.push({
      id: edgeKey(nodeId, compNodeId(record.competencyCode)),
      source_id: nodeId,
      target_id: compNodeId(record.competencyCode),
      kind: "competency",
      weight: 1,
    });
  }
  await upsertEdges(hubEdges);
}

/**
 * Recompute 'mentor_supplied' from surviving evidence: a concept may only keep
 * that status while at least one mentor provenance edge remains. Human
 * decisions (verified/rejected) are never touched, and no verificationHistory
 * entry is appended — mentor_supplied is a system-derived status (ingestion
 * sets it without history), so its withdrawal-driven fallback to 'unverified'
 * is equally silent.
 */
async function demoteStaleMentorSupplied(conceptIds: string[]): Promise<void> {
  const ids = [...new Set(conceptIds)];
  if (ids.length === 0) return;
  const [nodesRes, provRes] = await Promise.all([
    supabase.from("knowledge_nodes").select("id, verification_status").in("id", ids),
    supabase
      .from("knowledge_edges")
      .select("source_id, target_id")
      .eq("kind", "knowledge")
      .in("target_id", ids),
  ]);
  if (nodesRes.error) throw nodesRes.error;
  if (provRes.error) throw provRes.error;

  const mentorBacked = new Set<string>();
  for (const e of provRes.data ?? []) {
    const src = (e as Record<string, unknown>)["source_id"] as string;
    const tgt = (e as Record<string, unknown>)["target_id"] as string;
    if (src.startsWith("mentor:")) mentorBacked.add(tgt);
  }

  const demote = (nodesRes.data ?? [])
    .map((r) => r as Record<string, unknown>)
    .filter(
      (n) =>
        ((n["verification_status"] as string | null) ?? "unverified") === "mentor_supplied" &&
        !mentorBacked.has(n["id"] as string),
    )
    .map((n) => n["id"] as string);

  if (demote.length > 0) {
    const { error } = await supabase
      .from("knowledge_nodes")
      .update({ verification_status: "unverified", updated_at: new Date().toISOString() })
      .in("id", demote);
    if (error) throw error;
  }
}

/** Summary of a completed mentor withdrawal, returned to the admin. */
export interface MentorWithdrawalSummary {
  mentorProfileId: string;
  conceptsRetained: number;
  conceptsArchived: number;
  candidatesDeleted: number;
  candidatesScrubbed: number;
}

export type MentorWithdrawalResult =
  | { ok: true; summary: MentorWithdrawalSummary }
  | { ok: false; code: "not_found" };

/**
 * Withdraw a mentor entirely: graph re-evaluation FIRST (removeMentorGraph —
 * retryable and convergent), then knowledge_candidates attribution (pending
 * rows are deleted outright — they are mentor-sourced by construction and can
 * never be resolved once the answers are gone; resolved rows keep their
 * accept/merge/reject audit record but lose every mentor-identifying field),
 * and the mentor_profiles row LAST (cascading interview_sessions +
 * interview_answers). Because the destructive profile delete is the final
 * step, a mid-flight failure leaves the withdrawal retryable: every earlier
 * step is idempotent, so the retry converges. Replaying a completed
 * withdrawal returns not_found (the profile row is gone).
 *
 * Admin-gated at the route layer — the API holds the service-role key and is
 * otherwise unauthenticated, and this is a destructive action.
 */
export async function withdrawMentor(profileId: string): Promise<MentorWithdrawalResult> {
  const { data: profile, error: pErr } = await supabase
    .from("mentor_profiles")
    .select("id")
    .eq("id", profileId)
    .maybeSingle();
  if (pErr) throw pErr;
  if (!profile) return { ok: false, code: "not_found" };

  // 1) Graph evaluation first — same ordering discipline as candidate
  //    resolution: the graph write precedes the row that marks completion.
  const graph = await removeMentorGraph(profileId);

  // 2) Candidates: delete pending rows, scrub attribution off resolved ones.
  const { data: pendingRows, error: listErr } = await supabase
    .from("knowledge_candidates")
    .select("id")
    .eq("mentor_profile_id", profileId)
    .eq("status", "pending");
  if (listErr) throw listErr;
  const pendingIds = (pendingRows ?? []).map((r) => (r as Record<string, unknown>)["id"] as string);
  if (pendingIds.length > 0) {
    const { error } = await supabase.from("knowledge_candidates").delete().in("id", pendingIds);
    if (error) throw error;
  }

  const { data: resolvedRows, error: resErr } = await supabase
    .from("knowledge_candidates")
    .select("id")
    .eq("mentor_profile_id", profileId);
  if (resErr) throw resErr;
  const scrubIds = (resolvedRows ?? []).map((r) => (r as Record<string, unknown>)["id"] as string);
  if (scrubIds.length > 0) {
    const { error } = await supabase
      .from("knowledge_candidates")
      .update({
        mentor_profile_id: null,
        mentor_name: null,
        answer_id: null,
        session_id: null,
        updated_at: new Date().toISOString(),
      })
      .in("id", scrubIds);
    if (error) throw error;
  }

  // 3) The person, last: profile row deletion cascades sessions + answers.
  const { error: dErr } = await supabase.from("mentor_profiles").delete().eq("id", profileId);
  if (dErr) throw dErr;

  return {
    ok: true,
    summary: {
      mentorProfileId: profileId,
      conceptsRetained: graph.retainedConceptIds.length,
      conceptsArchived: graph.archivedConceptIds.length,
      candidatesDeleted: pendingIds.length,
      candidatesScrubbed: scrubIds.length,
    },
  };
}

/** A mentor-only concept that would be archived out of the live graph. */
export interface WithdrawalPreviewConcept {
  id: string;
  label: string;
  category: string;
}

/** Dry-run projection of what withdrawing a mentor would do — no writes. */
export interface MentorWithdrawalPreview {
  mentorProfileId: string;
  conceptsRetained: number;
  conceptsArchived: number;
  candidatesDeleted: number;
  candidatesScrubbed: number;
  archivedConcepts: WithdrawalPreviewConcept[];
}

export type MentorWithdrawalPreviewResult =
  | { ok: true; preview: MentorWithdrawalPreview }
  | { ok: false; code: "not_found" };

/**
 * Read-only counterpart to withdrawMentor: project exactly what a withdrawal
 * WOULD do without touching the graph, candidates, or profile. It reuses the
 * same concept-evaluation logic as removeMentorGraph (partition the concepts
 * this mentor corroborates into those that survive on other evidence vs. the
 * mentor-only ones that would be archived) and the same candidate-attribution
 * queries as withdrawMentor (pending rows deleted, resolved rows scrubbed), so
 * the preview and the actual action can never diverge in what they report.
 *
 * The archived-concept LABELS are included so the admin sees precisely which
 * pieces of knowledge would leave the live graph before confirming this
 * irreversible action. Admin-gated at the route layer, like withdrawMentor.
 */
export async function previewMentorWithdrawal(
  profileId: string,
): Promise<MentorWithdrawalPreviewResult> {
  const { data: profile, error: pErr } = await supabase
    .from("mentor_profiles")
    .select("id")
    .eq("id", profileId)
    .maybeSingle();
  if (pErr) throw pErr;
  if (!profile) return { ok: false, code: "not_found" };

  const mNode = mentorNodeId(profileId);

  // Concepts this mentor corroborates (same source as removeMentorGraph).
  const affected = await provenanceTargetsForVideo(mNode);

  // Partition: which affected concepts still have provenance from OTHER sources?
  let retained: string[] = [];
  let orphaned: string[] = [];
  if (affected.length > 0) {
    const { data, error } = await supabase
      .from("knowledge_edges")
      .select("source_id, target_id")
      .eq("kind", "knowledge")
      .in("target_id", affected);
    if (error) throw error;
    const otherSourced = new Set<string>();
    for (const e of data ?? []) {
      const src = (e as Record<string, unknown>)["source_id"] as string;
      const tgt = (e as Record<string, unknown>)["target_id"] as string;
      if (src !== mNode) otherSourced.add(tgt);
    }
    retained = affected.filter((id) => otherSourced.has(id));
    orphaned = affected.filter((id) => !otherSourced.has(id));
  }

  // Resolve the mentor-only concepts to human-readable labels for the preview.
  let archivedConcepts: WithdrawalPreviewConcept[] = [];
  if (orphaned.length > 0) {
    const { data, error } = await supabase
      .from("knowledge_nodes")
      .select("id, kind, label")
      .in("id", orphaned);
    if (error) throw error;
    archivedConcepts = (data ?? []).map((row) => {
      const n = row as Record<string, unknown>;
      return {
        id: n["id"] as string,
        label: (n["label"] as string) ?? "",
        category: (n["kind"] as string) ?? "concept",
      };
    });
    archivedConcepts.sort((a, b) => a.label.localeCompare(b.label));
  }

  // Candidate counts, mirroring withdrawMentor's delete-pending / scrub-resolved
  // split (resolved = everything this mentor owns that is NOT pending).
  const { data: pendingRows, error: pendErr } = await supabase
    .from("knowledge_candidates")
    .select("id")
    .eq("mentor_profile_id", profileId)
    .eq("status", "pending");
  if (pendErr) throw pendErr;

  const { data: scrubRows, error: scrubErr } = await supabase
    .from("knowledge_candidates")
    .select("id")
    .eq("mentor_profile_id", profileId)
    .neq("status", "pending");
  if (scrubErr) throw scrubErr;

  return {
    ok: true,
    preview: {
      mentorProfileId: profileId,
      conceptsRetained: retained.length,
      conceptsArchived: orphaned.length,
      candidatesDeleted: (pendingRows ?? []).length,
      candidatesScrubbed: (scrubRows ?? []).length,
      archivedConcepts,
    },
  };
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
  reviewer: string | null = null,
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
  // changes, so re-affirming the same status never grows the log. Each entry now
  // records the accountable reviewer (the signed-in human behind the decision),
  // so a "verified" concept carries a name — not just what changed and when.
  // `reviewer` is null for anonymous/legacy sessions that carry no identity.
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
          { from: prevStatus, to: status, at: new Date().toISOString(), reviewer },
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

/**
 * Clear a single reviewed withdrawn-evidence entry from a concept's provenance.
 *
 * A `rejectedEvidence` entry is recorded automatically when a video is
 * re-processed and no longer extracts a concept it once corroborated. It is a
 * trust signal, not a live link — a concept only KEEPS such an entry if it
 * survived pruning, i.e. it still has at least one other corroborating source,
 * so the concept is always alive. Once a reviewer has opened the source video
 * and decided the drop is acceptable (or spurious), this clears that one entry.
 *
 * We deliberately do NOT re-add the dropped video as a source: the distilled
 * knowledge row for that concept-video pair was removed when the extraction
 * stopped producing it, so re-linking would either fabricate extraction data or
 * be silently re-withdrawn on the next re-process. `recomputeKnowledgeAggregates`
 * only ever FILTERS `rejectedEvidence` (it never re-adds), so this removal is
 * durable across future re-processing and self-heal rebuilds.
 *
 * Idempotent: a node with no matching entry is a no-op success (returns the node
 * unchanged). Returns null when the node is absent or is not a knowledge node.
 */
export async function restoreWithdrawnEvidence(
  nodeId: string,
  videoId: string,
): Promise<GraphNode | null> {
  const { data: existing, error: readErr } = await supabase
    .from("knowledge_nodes")
    .select("kind, meta")
    .eq("id", nodeId)
    .maybeSingle();
  if (readErr) throw readErr;
  if (!existing) return null;

  const ex = existing as Record<string, unknown>;
  const kind = ex["kind"] as string;
  if (!KNOWLEDGE_NODE_KINDS.includes(kind as KnowledgeNodeKind)) return null;

  const prevMeta = (ex["meta"] as Record<string, unknown>) ?? {};
  const prevRejected = Array.isArray(prevMeta["rejectedEvidence"])
    ? (prevMeta["rejectedEvidence"] as Array<Record<string, unknown>>)
    : [];
  const rejectedEvidence = prevRejected.filter((r) => r["videoId"] !== videoId);

  // No matching entry (or none at all): idempotent no-op — re-read the current
  // row so the caller always gets the persisted node back, unchanged.
  const readCurrent = rejectedEvidence.length === prevRejected.length;

  const { data: updated, error: updErr } = readCurrent
    ? await supabase.from("knowledge_nodes").select("*").eq("id", nodeId).single()
    : await supabase
        .from("knowledge_nodes")
        .update({
          meta: { ...prevMeta, rejectedEvidence },
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

// ---------------------------------------------------------------------------
// Knowledge Write Verification
// ---------------------------------------------------------------------------
//
// A successful video upload OR mentor answer must NEVER silently fail to enter
// the graph. Every write reports a manifest of exactly what it was supposed to
// land; verifyGraphWrite reads the persisted graph back and confirms it. On a
// non-verified result the pipeline retries forward (no rollback — the nodes are
// shared) and never reports success. verifyAndRecordGraphWrite also persists an
// audit row to knowledge_write_log, the admin Graph Health dashboard's source of
// truth.

/**
 * A precise record of what a single knowledge write (one video distillation or
 * one mentor answer) was SUPPOSED to land in the graph. The writer produces it
 * from the very ids it upserted, so verification compares intent against the
 * persisted graph instead of re-deriving the expectation (which would drift).
 */
export interface GraphWriteManifest {
  scope: "video" | "mentor_answer";
  /** videoId or answerId — the thing whose write we are verifying. */
  refId: string;
  /** The provenance source node every expected edge originates from. */
  sourceNodeId: string;
  /** Canonical concept node ids this write reinforced or created. */
  expectedNodeIds: string[];
  /** Provenance edge ids (sourceNode -> concept) this write wrote. */
  expectedEdgeIds: string[];
  /** Concept nodes this write newly minted, which must carry an embedding. */
  embeddingNodeIds: string[];
}

/** One verification check's verdict + a human-readable detail for the dashboard. */
export interface WriteCheck {
  ok: boolean;
  detail: string;
}

/** The five checks that together prove a knowledge write actually landed. */
export interface GraphWriteChecks {
  nodesExist: WriteCheck;
  edgesExist: WriteCheck;
  provenanceStored: WriteCheck;
  confidenceUpdated: WriteCheck;
  searchIndexUpdated: WriteCheck;
}

export interface GraphWriteVerification {
  /** verified = all checks passed; partial = some landed; failed = none landed. */
  status: "verified" | "partial" | "failed";
  checks: GraphWriteChecks;
  summary: string;
}

/**
 * Build the write manifest for a mentor answer from its distillation outcomes.
 * Only concepts that actually landed in the live graph (reinforced/created) are
 * expected — queued candidates live OUTSIDE the graph by design — and 'created'
 * concepts are the newly minted nodes that must carry an embedding.
 */
export function buildMentorAnswerManifest(
  mentorProfileId: string,
  answerId: string,
  outcomes: MentorKnowledgeOutcome[],
): GraphWriteManifest {
  const mNode = mentorNodeId(mentorProfileId);
  const landed = outcomes.filter((o) => o.outcome !== "queued");
  const expectedNodeIds = [
    ...new Set(landed.map((o) => o.canonicalId).filter((id): id is string => id !== null)),
  ];
  const expectedEdgeIds = expectedNodeIds.map((id) => edgeKey(mNode, id));
  const embeddingNodeIds = [
    ...new Set(
      landed
        .filter((o) => o.outcome === "created")
        .map((o) => o.canonicalId)
        .filter((id): id is string => id !== null),
    ),
  ];
  return {
    scope: "mentor_answer",
    refId: answerId,
    sourceNodeId: mNode,
    expectedNodeIds,
    expectedEdgeIds,
    embeddingNodeIds,
  };
}

/**
 * Confirm the search index this write depends on was updated: newly minted
 * concept nodes carry an embedding (both scopes), and — for videos — every
 * transcript segment is embedded and a transcribed video carries a whole-video
 * embedding (that's what powers citations and related-video discovery). Uses
 * id-only reads (never fetches the vectors themselves) so the happy path is cheap.
 */
async function verifySearchIndex(
  scope: "video" | "mentor_answer",
  refId: string,
  embeddingNodeIds: string[],
): Promise<WriteCheck> {
  let missingNodeEmbeddings = 0;
  if (embeddingNodeIds.length > 0) {
    const { data, error } = await supabase
      .from("knowledge_nodes")
      .select("id")
      .in("id", embeddingNodeIds)
      .not("embedding", "is", null);
    if (error) throw error;
    const withEmbedding = new Set(
      (data ?? []).map((r) => (r as Record<string, unknown>)["id"]),
    );
    missingNodeEmbeddings = embeddingNodeIds.filter((id) => !withEmbedding.has(id)).length;
  }

  if (scope === "video") {
    const { data: nullSegs, error: segErr } = await supabase
      .from("transcript_segments")
      .select("id")
      .eq("video_id", refId)
      .is("embedding", null);
    if (segErr) throw segErr;
    const unembeddedSegments = (nullSegs ?? []).length;

    const { data: allSegs, error: allErr } = await supabase
      .from("transcript_segments")
      .select("id")
      .eq("video_id", refId);
    if (allErr) throw allErr;
    const hasSegments = (allSegs ?? []).length > 0;

    // A video with transcript segments must carry a whole-video embedding; a
    // video that legitimately had no transcript is exempt.
    let videoEmbedded = true;
    if (hasSegments) {
      const { data: vid, error: vErr } = await supabase
        .from("videos")
        .select("id")
        .eq("id", refId)
        .not("embedding", "is", null)
        .maybeSingle();
      if (vErr) throw vErr;
      videoEmbedded = !!vid;
    }

    const problems: string[] = [];
    if (unembeddedSegments > 0)
      problems.push(`${unembeddedSegments} transcript segment(s) not embedded`);
    if (!videoEmbedded) problems.push("whole-video embedding missing");
    if (missingNodeEmbeddings > 0)
      problems.push(`${missingNodeEmbeddings} new concept node(s) not embedded`);
    return {
      ok: problems.length === 0,
      detail: problems.length === 0 ? "search index up to date" : problems.join("; "),
    };
  }

  return {
    ok: missingNodeEmbeddings === 0,
    detail:
      missingNodeEmbeddings === 0
        ? "concept embeddings up to date"
        : `${missingNodeEmbeddings} new concept node(s) not embedded`,
  };
}

/**
 * Read the persisted graph back and confirm a write landed. Never throws for a
 * missing artifact — a missing node/edge is a failed CHECK, not an exception —
 * so the caller always gets a verdict. (A read that itself errors DOES throw;
 * verifyAndRecordGraphWrite turns that into a 'failed' verdict.)
 */
export async function verifyGraphWrite(
  manifest: GraphWriteManifest,
): Promise<GraphWriteVerification> {
  const { scope, refId, expectedNodeIds, expectedEdgeIds, embeddingNodeIds } = manifest;

  // Nodes exist + confidence recomputed (one read serves both).
  const nodeRows = new Map<string, Record<string, unknown>>();
  if (expectedNodeIds.length > 0) {
    const { data, error } = await supabase
      .from("knowledge_nodes")
      .select("id, confidence")
      .in("id", expectedNodeIds);
    if (error) throw error;
    for (const r of data ?? [])
      nodeRows.set((r as Record<string, unknown>)["id"] as string, r as Record<string, unknown>);
  }
  const missingNodes = expectedNodeIds.filter((id) => !nodeRows.has(id));
  const nodesExist: WriteCheck = {
    ok: missingNodes.length === 0,
    detail:
      missingNodes.length === 0
        ? `${expectedNodeIds.length} concept node(s) present`
        : `${missingNodes.length} of ${expectedNodeIds.length} concept node(s) missing`,
  };
  const noConfidence = expectedNodeIds.filter((id) => {
    const row = nodeRows.get(id);
    return !row || typeof row["confidence"] !== "number";
  });
  const confidenceUpdated: WriteCheck = {
    ok: noConfidence.length === 0,
    detail:
      noConfidence.length === 0
        ? `confidence set on ${expectedNodeIds.length} node(s)`
        : `${noConfidence.length} node(s) missing a recomputed confidence`,
  };

  // Edges exist + provenance stored (one read serves both).
  const edgeRows = new Map<string, Record<string, unknown>>();
  if (expectedEdgeIds.length > 0) {
    const { data, error } = await supabase
      .from("knowledge_edges")
      .select("id, source_id, target_id, meta")
      .in("id", expectedEdgeIds);
    if (error) throw error;
    for (const r of data ?? [])
      edgeRows.set((r as Record<string, unknown>)["id"] as string, r as Record<string, unknown>);
  }
  const missingEdges = expectedEdgeIds.filter((id) => !edgeRows.has(id));
  const edgesExist: WriteCheck = {
    ok: missingEdges.length === 0,
    detail:
      missingEdges.length === 0
        ? `${expectedEdgeIds.length} provenance edge(s) present`
        : `${missingEdges.length} of ${expectedEdgeIds.length} provenance edge(s) missing`,
  };
  // Provenance = the edge carries the extraction record tying this source to the
  // concept. Video edges record extractedAt/confidence; mentor edges record this
  // answerId in their answerIds ledger.
  let provenanceBad = 0;
  for (const id of expectedEdgeIds) {
    const row = edgeRows.get(id);
    if (!row) {
      provenanceBad++;
      continue;
    }
    const meta = (row["meta"] as Record<string, unknown>) ?? {};
    if (scope === "mentor_answer") {
      const answerIds = Array.isArray(meta["answerIds"]) ? (meta["answerIds"] as unknown[]) : [];
      if (!answerIds.includes(refId)) provenanceBad++;
    } else {
      const hasProv =
        typeof meta["extractedAt"] === "string" || typeof meta["confidence"] === "number";
      if (!hasProv) provenanceBad++;
    }
  }
  const provenanceStored: WriteCheck = {
    ok: provenanceBad === 0,
    detail:
      provenanceBad === 0
        ? `provenance recorded on ${expectedEdgeIds.length} edge(s)`
        : `${provenanceBad} edge(s) missing provenance metadata`,
  };

  const searchIndexUpdated = await verifySearchIndex(scope, refId, embeddingNodeIds);

  const checks: GraphWriteChecks = {
    nodesExist,
    edgesExist,
    provenanceStored,
    confidenceUpdated,
    searchIndexUpdated,
  };
  const failed = Object.entries(checks).filter(([, c]) => !c.ok);
  // Something landed if any expected node/edge is present. When nothing was
  // expected (a legit empty write) a check can still fail — that's the search
  // index — which is a real failure, not a partial.
  const anyPresent = nodeRows.size > 0 || edgeRows.size > 0;
  let status: GraphWriteVerification["status"];
  if (failed.length === 0) status = "verified";
  else if (anyPresent) status = "partial";
  else status = "failed";
  const summary =
    failed.length === 0
      ? "All knowledge-write checks passed."
      : failed.map(([name, c]) => `${name}: ${c.detail}`).join("; ");
  return { status, checks, summary };
}

/**
 * PostgREST keeps an in-memory schema cache that can go briefly stale right
 * after a DDL change or on a fresh connection — a read/write to a real table
 * then fails with "Could not find the table '…' in the schema cache" (code
 * PGRST205) or the column variant PGRST204. This is transient: the cache
 * reloads within moments. We MUST NOT let this false alarm flip a knowledge
 * write that actually landed to 'failed', so callers retry these distinctly
 * from a genuine missing-node/missing-edge verdict.
 */
export function isTransientSchemaCacheError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (code === "PGRST205" || code === "PGRST204" || code === "PGRST202") return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" && /schema cache/i.test(message);
}

/**
 * Run a Supabase operation, retrying only when it fails with a transient
 * PostgREST schema-cache error (see isTransientSchemaCacheError). A short delay
 * gives PostgREST time to reload its cache before the retry. Any other error is
 * rethrown immediately — this never masks a real failure.
 */
async function withSchemaCacheRetry<T>(
  op: () => Promise<T>,
  { attempts = 3, delayMs = 400 }: { attempts?: number; delayMs?: number } = {},
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await op();
    } catch (err) {
      if (!isTransientSchemaCacheError(err)) throw err;
      lastErr = err;
      if (i < attempts - 1) {
        logger.warn(
          { err, attempt: i + 1 },
          "transient PostgREST schema-cache error; retrying after reload window",
        );
        await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
      }
    }
  }
  throw lastErr;
}

/** Persist (upsert) one audit row for a knowledge write. Best-effort telemetry:
 * a failure to record the audit row must never mask the verification verdict. */
async function recordGraphWrite(
  manifest: GraphWriteManifest,
  verification: GraphWriteVerification,
  meta: { attempts?: number; startedAtMs?: number },
): Promise<void> {
  try {
    const id = `wl:${manifest.scope === "video" ? "video" : "answer"}:${manifest.refId}`;
    await withSchemaCacheRetry(async () => {
      const { error } = await supabase.from("knowledge_write_log").upsert(
        {
          id,
          scope: manifest.scope,
          ref_id: manifest.refId,
          status: verification.status,
          checks: verification.checks,
          error: verification.status === "verified" ? null : verification.summary,
          duration_ms:
            typeof meta.startedAtMs === "number" ? Date.now() - meta.startedAtMs : null,
          attempts: meta.attempts ?? 1,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "id" },
      );
      if (error) throw error;
    });
  } catch (err) {
    logger.error(
      { err, scope: manifest.scope, refId: manifest.refId },
      "failed to record knowledge write log",
    );
  }
}

/**
 * Verify a knowledge write and record its audit row. Returns the verdict so the
 * caller can decide whether to report success. A verification READ that itself
 * fails yields a 'failed' verdict (we can't confirm the write → never claim
 * success), which the caller treats as retry-forward.
 */
export async function verifyAndRecordGraphWrite(
  manifest: GraphWriteManifest,
  meta: { attempts?: number; startedAtMs?: number } = {},
): Promise<GraphWriteVerification> {
  let verification: GraphWriteVerification;
  try {
    // Retry only transient PostgREST schema-cache staleness — a genuine
    // missing-node/edge is not an exception (verifyGraphWrite returns a verdict),
    // so a landed write is never mislabelled 'failed' because the cache was cold.
    verification = await withSchemaCacheRetry(() => verifyGraphWrite(manifest));
  } catch (err) {
    const detail = "verification read failed";
    verification = {
      status: "failed",
      checks: {
        nodesExist: { ok: false, detail },
        edgesExist: { ok: false, detail },
        provenanceStored: { ok: false, detail },
        confidenceUpdated: { ok: false, detail },
        searchIndexUpdated: { ok: false, detail },
      },
      summary: `Verification read failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  await recordGraphWrite(manifest, verification, meta);
  return verification;
}

// ---------------------------------------------------------------------------
// Graph Health dashboard
// ---------------------------------------------------------------------------

export interface GraphHealthWrite {
  id: string;
  scope: string;
  refId: string;
  status: string;
  error: string | null;
  durationMs: number | null;
  attempts: number;
  updatedAt: string | null;
  checks: Record<string, WriteCheck>;
}

export interface GraphHealthReport {
  counts: { verified: number; partial: number; failed: number; pending: number; total: number };
  /** Work awaiting a retry: videos in the backoff ladder + answers to redistill. */
  retryQueue: { videos: number; answers: number; total: number };
  /** Mean duration of verified writes (ms), or null when none recorded yet. */
  avgProcessingMs: number | null;
  recentWrites: GraphHealthWrite[];
}

/** Coerce a stored checks JSONB blob back into the typed check map defensively. */
function normalizeChecks(raw: unknown): Record<string, WriteCheck> {
  const out: Record<string, WriteCheck> = {};
  if (raw && typeof raw === "object") {
    for (const [name, val] of Object.entries(raw as Record<string, unknown>)) {
      if (val && typeof val === "object") {
        const v = val as Record<string, unknown>;
        out[name] = {
          ok: Boolean(v["ok"]),
          detail: typeof v["detail"] === "string" ? (v["detail"] as string) : "",
        };
      }
    }
  }
  return out;
}

/** Assemble the admin Graph Health report from the write log + retry sources. */
export async function getGraphHealth(recentLimit = 25): Promise<GraphHealthReport> {
  const { data: logs, error } = await supabase
    .from("knowledge_write_log")
    .select("id, scope, ref_id, status, error, duration_ms, attempts, checks, updated_at")
    .order("updated_at", { ascending: false });
  if (error) throw error;
  const rows = (logs ?? []) as Array<Record<string, unknown>>;

  const counts = { verified: 0, partial: 0, failed: 0, pending: 0, total: rows.length };
  let durSum = 0;
  let durN = 0;
  for (const r of rows) {
    const s = String(r["status"] ?? "pending");
    if (s === "verified") counts.verified++;
    else if (s === "partial") counts.partial++;
    else if (s === "failed") counts.failed++;
    else counts.pending++;
    if (s === "verified" && typeof r["duration_ms"] === "number") {
      durSum += r["duration_ms"] as number;
      durN++;
    }
  }

  const { data: vids, error: vErr } = await supabase
    .from("videos")
    .select("id")
    .in("status", ["retrying", "failed"]);
  if (vErr) throw vErr;
  const { data: ans, error: aErr } = await supabase
    .from("interview_answers")
    .select("id")
    .eq("distillation_status", "failed");
  if (aErr) throw aErr;
  const videoQueue = (vids ?? []).length;
  const answerQueue = (ans ?? []).length;

  const recentWrites: GraphHealthWrite[] = rows.slice(0, recentLimit).map((r) => ({
    id: String(r["id"] ?? ""),
    scope: String(r["scope"] ?? ""),
    refId: String(r["ref_id"] ?? ""),
    status: String(r["status"] ?? "pending"),
    error: (r["error"] as string | null) ?? null,
    durationMs: typeof r["duration_ms"] === "number" ? (r["duration_ms"] as number) : null,
    attempts: typeof r["attempts"] === "number" ? (r["attempts"] as number) : 0,
    updatedAt: (r["updated_at"] as string | null) ?? null,
    checks: normalizeChecks(r["checks"]),
  }));

  return {
    counts,
    retryQueue: { videos: videoQueue, answers: answerQueue, total: videoQueue + answerQueue },
    avgProcessingMs: durN > 0 ? Math.round(durSum / durN) : null,
    recentWrites,
  };
}
