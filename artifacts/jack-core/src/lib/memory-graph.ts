/**
 * memory-graph — shared data model for Jack's "Living Memory" graph.
 *
 * Turns the raw video + competency data into a topic-clustered node/edge graph:
 *   JACK core → topic hubs (one per trade) → competency nodes + video nodes.
 *
 * It is intentionally honest about real data: nodes only exist for things Jack
 * actually knows about (ingested videos, seeded Red Seal competencies). Density
 * grows on its own as more videos are processed and segments are indexed.
 *
 * Both the interactive page graph (MemoryGraphCanvas) and the ambient wallpaper
 * (KnowledgeGraph) can build on these helpers.
 */

export type RGB = readonly [number, number, number];

/** The /videos list & /videos/recent endpoints return raw snake_case rows while
 *  /videos/:id maps to camelCase — read both so we are resilient either way. */
export interface RawVideo {
  id: string;
  title?: string;
  description?: string | null;
  trade?: string | null;
  status?: string;
  competencyCodes?: string[] | null;
  competency_codes?: string[] | null;
  uploaderUserId?: string | null;
  uploader_user_id?: string | null;
  uploaderEmail?: string | null;
  uploader_email?: string | null;
  uploaderName?: string | null;
  uploader_name?: string | null;
  createdAt?: string | null;
  created_at?: string | null;
  updatedAt?: string | null;
  updated_at?: string | null;
}

export interface RawCompetency {
  code: string;
  name: string;
  trade: string;
  description?: string | null;
  videoCount?: number;
}

/** Atomic knowledge categories distilled from transcripts (Living Memory). */
export const KNOWLEDGE_KINDS = [
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

export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

export type NodeKind =
  | "core"
  | "topic"
  | "video"
  | "competency"
  | "mentor"
  | "contributor"
  | KnowledgeKind;

/** Signature color for mentor (human-sourced) nodes, distinct from the video and
 *  atomic-knowledge strata so mentor-supplied corroboration reads at a glance. */
export const MENTOR_COLOR: RGB = [255, 205, 120];
/** Contributor nodes are signed-in uploaders: human provenance for video-based
 *  submissions, separate from Interview Mode mentor profile nodes. */
export const CONTRIBUTOR_COLOR: RGB = [120, 220, 255];

const KNOWLEDGE_KIND_SET = new Set<string>(KNOWLEDGE_KINDS);

export function isKnowledgeKind(kind: string): kind is KnowledgeKind {
  return KNOWLEDGE_KIND_SET.has(kind);
}

/** One source video that corroborates an atomic knowledge node. */
export interface NodeSource {
  videoId: string;
  timestamps: number[];
  confidence: number;
  /** The model + date that distilled this contribution; null on pre-provenance
   *  edges (kept null rather than fabricated so the derived aggregates stay honest). */
  model?: string | null;
  extractedAt?: string | null;
}

/** One point in a concept's confidence-over-time log (append-on-change). */
export interface ConfidencePoint {
  confidence: number;
  sourceCount: number;
  at: string;
}

/** Another concept identity that collapsed onto this canonical node. */
export interface MergedConcept {
  id: string;
  label: string;
  category?: string;
  at?: string;
}

/** A video that USED to corroborate this concept but no longer does. */
export interface RejectedEvidence {
  videoId: string;
  at?: string;
  reason?: string;
}

/** A human verify/reject/reset transition, attributed to the signed-in reviewer. */
export interface VerificationTransition {
  from: string;
  to: string;
  at: string;
  /** Name of the reviewer who made the decision; null for legacy/anon entries. */
  reviewer?: string | null;
}

export interface MemoryNode {
  id: string;
  kind: NodeKind;
  label: string;
  /** Topic (trade) this node belongs to; undefined for the core. */
  topicId?: string;
  color: RGB;
  status?: string;
  meta: {
    trade?: string;
    code?: string;
    description?: string;
    createdAt?: string;
    updatedAt?: string;
    competencyCodes?: string[];
    videoCount?: number;
    uploaderUserId?: string;
    uploaderEmail?: string;
    uploaderName?: string;
    userId?: string;
    email?: string;
    name?: string;
    /** Atomic-knowledge fields (present only for KnowledgeKind nodes). */
    category?: string;
    refId?: string;
    confidence?: number;
    verificationStatus?: string;
    sourceCount?: number;
    sourceVideoIds?: string[];
    timestamps?: number[];
    sources?: NodeSource[];
    /** Alternate wordings that collapse onto this canonical node (capped 25). */
    aliases?: string[];
    /**
     * Knowledge Provenance ledger fields (present only for KnowledgeKind nodes).
     * All are DERIVED from the node's provenance edges except verificationHistory
     * (the human decision log). They power the inspector's "why do we know this?"
     * view: which models extracted it, when, how confidence moved, what merged
     * in, and which evidence was later withdrawn.
     */
    models?: string[];
    firstExtractedAt?: string;
    lastExtractedAt?: string;
    confidenceHistory?: ConfidencePoint[];
    mergedFrom?: MergedConcept[];
    rejectedEvidence?: RejectedEvidence[];
    verificationHistory?: VerificationTransition[];
    /**
     * Non-video Knowledge Entries filed under this trade (topic hubs only).
     * Stamped onto the DISPLAYED model by `withKnowledgeCounts` from the
     * `/knowledge/stats` endpoint; folded into the hub's `contentCount` so a
     * trade taught only through written field notes still reads as populated.
     */
    knowledgeObjectCount?: number;
  };
  /**
   * Future-proof capture blob — present (possibly empty) on EVERY node so the
   * UI never has to be restructured as Jack's memory grows richer. Populated by
   * `finalizeModel`; read via `nodeCapture(node)` which falls back to deriving
   * it on the fly for any node that predates finalization.
   */
  capture?: NodeCapture;
}

/**
 * The full knowledge a node can eventually carry. Every field is always present
 * (empty when unknown) so downstream UI can bind to a stable shape today and
 * light up automatically as the backend starts supplying each field.
 */
export interface NodeCapture {
  summary: string;
  transcript: string;
  videoIds: string[];
  sourceConversations: string[];
  procedures: string[];
  fieldTips: string[];
  commonMistakes: string[];
  citations: NodeSource[];
  embeddings: number[];
  relatedCompetencies: string[];
  metadata: Record<string, unknown>;
}

/** Per-trade cluster rollup, shown on/near each hub before drilling in. */
export interface ClusterMetrics {
  knowledge: number;
  videos: number;
  conversations: number;
  procedures: number;
  competencies: number;
  /** Mean confidence across this hub's knowledge nodes (0..1). */
  avgConfidence: number;
  /** Share of knowledge nodes taught by ≥2 sources (0..1). */
  corroboratedShare: number;
  /** Composite 0..1 "how grown-up is this cluster" score (size + trust). */
  maturity: number;
}

export interface MemoryEdge {
  a: string;
  b: string;
  kind: string;
  /** Corroboration weight from the server (hub edges); undefined client-side. */
  weight?: number;
}

/** Stable key for an edge, shared with the canvas so births/strengthening line up. */
export function edgeKey(e: MemoryEdge): string {
  return `${e.a}->${e.b}:${e.kind}`;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Composite "how grown-up is this cluster" score (0..1): a cluster with more
 * concepts, higher average confidence, and more cross-corroborated knowledge
 * reads as more mature. Size is capped so a large hub can't drown out trust.
 */
export function clusterMaturity(m: ClusterMetrics): number {
  const size = clamp01(m.knowledge / 12);
  return clamp01(0.4 * size + 0.3 * m.avgConfidence + 0.3 * m.corroboratedShare);
}

/** A whole-graph vitality read-out, derived entirely from the public graph. */
export interface MemoryVitality {
  knowledgeCount: number;
  /** Share verified or mentor-corroborated by a human/mentor (0..1). */
  verifiedShare: number;
  /** Share taught by ≥2 sources (0..1). */
  corroboratedShare: number;
  avgConfidence: number;
  /** Composite 0..1 health score used for the ambient indicator. */
  score: number;
}

/** Roll the knowledge layer up into a single vitality snapshot. */
export function computeVitality(model: GraphModel): MemoryVitality {
  let knowledgeCount = 0;
  let confSum = 0;
  let verified = 0;
  let corroborated = 0;
  for (const n of model.nodes) {
    if (!isKnowledgeKind(n.kind)) continue;
    knowledgeCount += 1;
    confSum += typeof n.meta.confidence === "number" ? n.meta.confidence : 0.5;
    const status = (n.meta.verificationStatus ?? "").toLowerCase();
    if (status === "verified" || status === "mentor_supplied") verified += 1;
    if ((n.meta.sourceCount ?? 0) >= 2) corroborated += 1;
  }
  const avgConfidence = knowledgeCount ? confSum / knowledgeCount : 0;
  const verifiedShare = knowledgeCount ? verified / knowledgeCount : 0;
  const corroboratedShare = knowledgeCount ? corroborated / knowledgeCount : 0;
  const score = clamp01(
    0.45 * avgConfidence + 0.3 * corroboratedShare + 0.25 * verifiedShare,
  );
  return {
    knowledgeCount,
    verifiedShare,
    corroboratedShare,
    avgConfidence,
    score,
  };
}

/**
 * What changed between two graph snapshots. Consumed by the canvas (to birth
 * new nodes / pulse strengthened edges) and the view (growth counter + toasts).
 * `seq` only advances on a *real* change so effects can dedupe.
 */
export interface GraphDelta {
  seq: number;
  generatedAt?: string;
  addedNodeIds: string[];
  removedNodeIds: string[];
  newEdgeKeys: string[];
  /** Edges whose corroboration weight rose since the last snapshot. */
  strengthenedEdgeKeys: string[];
  /** Count of genuinely-new knowledge (concept/tool/hazard/…) nodes. */
  addedKnowledgeCount: number;
  /** New knowledge grouped by trade, for the "learned N in <Trade>" toast. */
  addedByTrade: { trade: string; count: number }[];
  /** Best node to focus when a toast is tapped (newest knowledge, else any). */
  newestNodeId?: string;
}

export const EMPTY_DELTA: GraphDelta = {
  seq: 0,
  addedNodeIds: [],
  removedNodeIds: [],
  newEdgeKeys: [],
  strengthenedEdgeKeys: [],
  addedKnowledgeCount: 0,
  addedByTrade: [],
};

/** Only genuinely fresh persisted nodes may produce a "just learned" toast. */
export const GROWTH_TOAST_RECENCY_MS = 60_000;

export function isRecentGrowthNode(
  node: MemoryNode,
  generatedAt?: string,
  windowMs = GROWTH_TOAST_RECENCY_MS,
): boolean {
  const nodeTime = Date.parse(
    node.meta.createdAt ??
      node.meta.firstExtractedAt ??
      node.meta.updatedAt ??
      node.meta.lastExtractedAt ??
      "",
  );
  if (!Number.isFinite(nodeTime)) return false;
  const snapshotTime = Date.parse(generatedAt ?? "");
  const now = Number.isFinite(snapshotTime) ? snapshotTime : Date.now();
  return nodeTime <= now + 5_000 && now - nodeTime <= windowMs;
}

/**
 * Diff two built models. `prev === null` (first load) yields an empty delta so
 * the whole graph never "births" on initial render — only genuinely-new nodes
 * that appear in a later snapshot animate in.
 */
export function computeGraphDelta(
  prev: GraphModel | null,
  next: GraphModel,
  seq: number,
  generatedAt?: string,
): GraphDelta {
  if (!prev) return { ...EMPTY_DELTA, seq, generatedAt };

  const prevNodeIds = new Set(prev.nodes.map((n) => n.id));
  const nextById = new Map(next.nodes.map((n) => [n.id, n]));

  const addedNodeIds: string[] = [];
  for (const n of next.nodes) if (!prevNodeIds.has(n.id)) addedNodeIds.push(n.id);
  const nextNodeIds = new Set(nextById.keys());
  const removedNodeIds: string[] = [];
  for (const id of prevNodeIds) if (!nextNodeIds.has(id)) removedNodeIds.push(id);

  const prevEdgeW = new Map<string, number>();
  for (const e of prev.edges) prevEdgeW.set(edgeKey(e), e.weight ?? 1);
  const newEdgeKeys: string[] = [];
  const strengthenedEdgeKeys: string[] = [];
  for (const e of next.edges) {
    const key = edgeKey(e);
    const before = prevEdgeW.get(key);
    if (before === undefined) newEdgeKeys.push(key);
    else if ((e.weight ?? 1) > before + 1e-6) strengthenedEdgeKeys.push(key);
  }

  // Summarize the new *knowledge* for the toast, grouped by trade.
  const byTrade = new Map<string, number>();
  let addedKnowledgeCount = 0;
  let newestNodeId: string | undefined;
  let newestAt = -Infinity;
  for (const id of addedNodeIds) {
    const n = nextById.get(id);
    if (!n) continue;
    if (isKnowledgeKind(n.kind) && isRecentGrowthNode(n, generatedAt)) {
      addedKnowledgeCount += 1;
      const trade = n.meta.trade ?? "General";
      byTrade.set(trade, (byTrade.get(trade) ?? 0) + 1);
      const t = Date.parse(n.meta.createdAt ?? n.meta.updatedAt ?? "");
      if (Number.isFinite(t) ? t >= newestAt : newestAt === -Infinity) {
        newestAt = Number.isFinite(t) ? t : newestAt;
        newestNodeId = id;
      }
    }
  }
  if (!newestNodeId && addedNodeIds.length) newestNodeId = addedNodeIds[0];

  const addedByTrade = [...byTrade.entries()]
    .map(([trade, count]) => ({ trade, count }))
    .sort((a, b) => b.count - a.count);

  const changed =
    addedNodeIds.length > 0 ||
    removedNodeIds.length > 0 ||
    newEdgeKeys.length > 0 ||
    strengthenedEdgeKeys.length > 0;

  return {
    seq: changed ? seq : seq - 1,
    generatedAt,
    addedNodeIds,
    removedNodeIds,
    newEdgeKeys,
    strengthenedEdgeKeys,
    addedKnowledgeCount,
    addedByTrade,
    newestNodeId,
  };
}

/** Human-facing label + signature color for every knowledge kind, so atomic
 *  nodes are visually distinguishable in the graph and legend. Colors are keyed
 *  by kind (not trade) so the atomic-knowledge layer reads as its own stratum. */
export const KNOWLEDGE_KIND_META: Record<
  KnowledgeKind,
  { label: string; color: RGB }
> = {
  concept: { label: "Concept", color: [130, 170, 255] },
  tool: { label: "Tool", color: [255, 180, 70] },
  equipment: { label: "Equipment", color: [178, 140, 248] },
  material: { label: "Material", color: [110, 220, 180] },
  procedure: { label: "Procedure", color: [90, 200, 250] },
  hazard: { label: "Hazard", color: [255, 95, 95] },
  slang: { label: "Slang", color: [255, 140, 200] },
  certification: { label: "Certification", color: [240, 210, 90] },
  standard: { label: "Standard", color: [150, 205, 120] },
  regional_term: { label: "Regional Term", color: [205, 165, 125] },
};

/** Display label for any node kind (used by the inspector + legend). */
export function kindLabel(kind: NodeKind): string {
  if (kind === "core") return "Memory Core";
  if (kind === "topic") return "Topic Hub";
  if (kind === "competency") return "Red Seal Competency";
  if (kind === "video") return "Video";
  if (kind === "mentor") return "Mentor";
  if (kind === "contributor") return "Contributor";
  return KNOWLEDGE_KIND_META[kind as KnowledgeKind]?.label ?? "Knowledge";
}

export interface Topic {
  id: string;
  trade: string;
  label: string;
  color: RGB;
  /** Cluster rollup for this trade, filled by `finalizeModel`. */
  metrics: ClusterMetrics;
}

export interface GraphModel {
  topics: Topic[];
  nodes: MemoryNode[];
  edges: MemoryEdge[];
  degree: Record<string, number>;
  counts: {
    nodes: number;
    connections: number;
    topics: number;
    videos: number;
    knowledge: number;
  };
}

export const CORE_ID = "__jack__";
export const CORE_COLOR: RGB = [255, 150, 60];

/** A vivid, well-separated palette echoing the reference design's topic colors. */
export const TOPIC_PALETTE: RGB[] = [
  [255, 134, 38], // orange
  [245, 197, 66], // gold
  [86, 204, 242], // sky
  [233, 92, 168], // magenta
  [99, 214, 142], // green
  [98, 132, 247], // blue
  [177, 116, 247], // purple
  [54, 211, 213], // teal
  [240, 110, 74], // coral
  [180, 214, 78], // lime
];

export function rgba(c: RGB, a: number): string {
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;
}

export function rgbCss(c: RGB): string {
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

/** Lighten/blend an RGB toward white by t (0..1). */
export function tint(c: RGB, t: number): RGB {
  return [
    Math.round(c[0] + (255 - c[0]) * t),
    Math.round(c[1] + (255 - c[1]) * t),
    Math.round(c[2] + (255 - c[2]) * t),
  ];
}

export function readCodes(v: RawVideo): string[] {
  return (v.competencyCodes ?? v.competency_codes ?? []) as string[];
}

export function readCreatedAt(v: RawVideo): string | undefined {
  return (v.createdAt ?? v.created_at ?? undefined) || undefined;
}

export function readUpdatedAt(v: RawVideo): string | undefined {
  return (v.updatedAt ?? v.updated_at ?? readCreatedAt(v)) || undefined;
}

export function readUploaderUserId(v: RawVideo): string | undefined {
  return (v.uploaderUserId ?? v.uploader_user_id ?? undefined) || undefined;
}

export function readUploaderEmail(v: RawVideo): string | undefined {
  return (v.uploaderEmail ?? v.uploader_email ?? undefined) || undefined;
}

export function readUploaderName(v: RawVideo): string | undefined {
  return (v.uploaderName ?? v.uploader_name ?? readUploaderEmail(v)) || undefined;
}

export function timeAgo(iso?: string): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function topicIdForTrade(trade: string): string {
  return `topic:${trade}`;
}

/** An all-zero cluster rollup, overwritten by `finalizeModel`. */
export function emptyMetrics(): ClusterMetrics {
  return {
    knowledge: 0,
    videos: 0,
    conversations: 0,
    procedures: 0,
    competencies: 0,
    avgConfidence: 0,
    corroboratedShare: 0,
    maturity: 0,
  };
}

/**
 * Derive the future-proof capture blob for a node from the data it already
 * carries. Everything is always present (empty when unknown) so the UI binds to
 * a stable shape and lights up automatically as the backend enriches nodes.
 */
export function deriveCapture(node: MemoryNode): NodeCapture {
  const m = node.meta;
  const citations = m.sources ?? [];
  const videoIds = new Set<string>();
  for (const s of citations) videoIds.add(s.videoId);
  for (const id of m.sourceVideoIds ?? []) videoIds.add(id);
  if (node.kind === "video") videoIds.add(node.id.replace("video:", ""));
  return {
    summary: m.description ?? "",
    transcript: "",
    videoIds: [...videoIds],
    sourceConversations: [],
    procedures: [],
    fieldTips: [],
    commonMistakes: [],
    citations,
    embeddings: [],
    relatedCompetencies: m.competencyCodes ?? [],
    metadata: {},
  };
}

/** Read a node's capture, deriving one on the fly if it predates finalization. */
export function nodeCapture(node: MemoryNode): NodeCapture {
  return node.capture ?? deriveCapture(node);
}

export type FreshnessState = "fresh" | "attention" | "gap";

export interface FreshnessInfo {
  state: FreshnessState;
  label: string;
  color: RGB;
}

const FRESH_WINDOW_MS = 1000 * 60 * 60 * 24 * 30;

const FRESHNESS: Record<FreshnessState, FreshnessInfo> = {
  fresh: { state: "fresh", label: "Fresh", color: [99, 214, 142] },
  attention: { state: "attention", label: "Needs Attention", color: [245, 197, 66] },
  gap: { state: "gap", label: "Knowledge Gap", color: [148, 163, 184] },
};

/**
 * Health of a single node: Knowledge Gap (no corroborating source data yet),
 * Needs Attention (has data but hasn't been touched in a while), or Fresh.
 * Scaffold roots (core/topic) always read Fresh — their health is the cluster's.
 */
export function nodeFreshness(node: MemoryNode): FreshnessInfo {
  if (node.kind === "core" || node.kind === "topic") return FRESHNESS.fresh;

  const cap = nodeCapture(node);
  const hasData =
    node.kind === "competency"
      ? (node.meta.videoCount ?? 0) > 0
      : cap.citations.length > 0 ||
        cap.videoIds.length > 0 ||
        cap.sourceConversations.length > 0 ||
        cap.summary.trim().length > 0;
  if (!hasData) return FRESHNESS.gap;

  const iso = node.meta.updatedAt ?? node.meta.createdAt;
  if (!iso) return FRESHNESS.fresh;
  const age = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(age)) return FRESHNESS.fresh;
  return age <= FRESH_WINDOW_MS ? FRESHNESS.fresh : FRESHNESS.attention;
}

/**
 * Finalize a freshly-built model: attach the future-proof capture blob to every
 * node, roll up per-trade cluster metrics onto each topic, and compute degree +
 * counts. Both the client-derived and server-derived builders route through here
 * so the two paths produce an identical, fully-populated shape.
 */
export function finalizeModel(
  topics: Topic[],
  rawNodes: MemoryNode[],
  edges: MemoryEdge[],
): GraphModel {
  const nodes = rawNodes.map((n) =>
    n.capture ? n : { ...n, capture: deriveCapture(n) },
  );

  const degree: Record<string, number> = {};
  for (const e of edges) {
    degree[e.a] = (degree[e.a] ?? 0) + 1;
    degree[e.b] = (degree[e.b] ?? 0) + 1;
  }

  const metricsByTrade = new Map<string, ClusterMetrics>();
  // Per-trade accumulators for the maturity roll-up, kept alongside the counts.
  const confSumByTrade = new Map<string, number>();
  const corroboratedByTrade = new Map<string, number>();
  for (const t of topics) {
    metricsByTrade.set(t.trade, emptyMetrics());
    confSumByTrade.set(t.trade, 0);
    corroboratedByTrade.set(t.trade, 0);
  }
  for (const n of nodes) {
    const trade = n.meta.trade;
    if (!trade) continue;
    const m = metricsByTrade.get(trade);
    if (!m) continue;
    if (n.kind === "video") m.videos += 1;
    else if (n.kind === "competency") m.competencies += 1;
    else if (n.kind === "mentor" || n.kind === "contributor") m.conversations += 1;
    else if (isKnowledgeKind(n.kind)) {
      m.knowledge += 1;
      if (n.kind === "procedure") m.procedures += 1;
      confSumByTrade.set(
        trade,
        (confSumByTrade.get(trade) ?? 0) +
          (typeof n.meta.confidence === "number" ? n.meta.confidence : 0.5),
      );
      if ((n.meta.sourceCount ?? 0) >= 2)
        corroboratedByTrade.set(trade, (corroboratedByTrade.get(trade) ?? 0) + 1);
    }
  }
  for (const [trade, m] of metricsByTrade) {
    if (m.knowledge > 0) {
      m.avgConfidence = (confSumByTrade.get(trade) ?? 0) / m.knowledge;
      m.corroboratedShare = (corroboratedByTrade.get(trade) ?? 0) / m.knowledge;
    }
    m.maturity = clusterMaturity(m);
  }
  const topicsWithMetrics = topics.map((t) => ({
    ...t,
    metrics: metricsByTrade.get(t.trade) ?? emptyMetrics(),
  }));

  return {
    topics: topicsWithMetrics,
    nodes,
    edges,
    degree,
    counts: {
      nodes: nodes.length,
      connections: edges.length,
      topics: topicsWithMetrics.length,
      videos: nodes.filter((n) => n.kind === "video").length,
      knowledge: nodes.filter((n) => isKnowledgeKind(n.kind)).length,
    },
  };
}

/**
 * Build the full graph model from the data Jack actually has.
 */
export function buildGraphModel(
  videos: RawVideo[],
  competencies: RawCompetency[],
): GraphModel {
  // 1. Collect topics (trades) from both videos and the competency catalog.
  const tradeSet = new Set<string>();
  for (const v of videos) if (v.trade) tradeSet.add(v.trade);
  for (const c of competencies) if (c.trade) tradeSet.add(c.trade);
  const trades = [...tradeSet].sort((a, b) => a.localeCompare(b));

  const topics: Topic[] = trades.map((trade, i) => ({
    id: topicIdForTrade(trade),
    trade,
    label: trade,
    color: TOPIC_PALETTE[i % TOPIC_PALETTE.length]!,
    metrics: emptyMetrics(),
  }));
  const topicByTrade = new Map(topics.map((t) => [t.trade, t]));

  const nodes: MemoryNode[] = [];
  const edges: MemoryEdge[] = [];

  // 2. Core.
  nodes.push({
    id: CORE_ID,
    kind: "core",
    label: "JACK",
    color: CORE_COLOR,
    meta: {},
  });

  // 3. Topic hubs.
  for (const t of topics) {
    nodes.push({
      id: t.id,
      kind: "topic",
      label: t.label,
      topicId: t.id,
      color: t.color,
      meta: { trade: t.trade },
    });
    edges.push({ a: CORE_ID, b: t.id, kind: "topic" });
  }

  // 4. Competency scaffold (real seeded Red Seal codes), grouped under topics.
  const compNodeIds = new Set<string>();
  for (const c of competencies) {
    const topic = topicByTrade.get(c.trade);
    if (!topic) continue;
    const id = `comp:${c.code}`;
    compNodeIds.add(id);
    nodes.push({
      id,
      kind: "competency",
      label: c.code,
      topicId: topic.id,
      color: tint(topic.color, 0.45),
      meta: {
        trade: c.trade,
        code: c.code,
        description: c.description ?? c.name,
        videoCount: c.videoCount,
      },
    });
    edges.push({ a: topic.id, b: id, kind: "competency" });
  }

  // 5. Videos — Jack's ingested memories.
  for (const v of videos) {
    const topic = v.trade ? topicByTrade.get(v.trade) : undefined;
    const id = `video:${v.id}`;
    const uploaderUserId = readUploaderUserId(v);
    const contributorId = uploaderUserId ? `contributor:${uploaderUserId}` : undefined;
    if (contributorId && !nodes.some((n) => n.id === contributorId)) {
      const name = readUploaderName(v) ?? "Contributor";
      nodes.push({
        id: contributorId,
        kind: "contributor",
        label: name,
        topicId: topic?.id,
        color: CONTRIBUTOR_COLOR,
        meta: {
          trade: v.trade ?? undefined,
          description: "Signed-in uploader whose field evidence feeds Jack's memory.",
          userId: uploaderUserId,
          email: readUploaderEmail(v),
          name,
        },
      });
      edges.push({ a: topic?.id ?? CORE_ID, b: contributorId, kind: "contributor" });
    }
    nodes.push({
      id,
      kind: "video",
      label: v.title ?? "Untitled",
      topicId: topic?.id,
      color: topic?.color ?? CORE_COLOR,
      status: v.status,
      meta: {
        trade: v.trade ?? undefined,
        description: v.description ?? undefined,
        createdAt: readCreatedAt(v),
        updatedAt: readUpdatedAt(v),
        competencyCodes: readCodes(v),
        uploaderUserId,
        uploaderEmail: readUploaderEmail(v),
        uploaderName: readUploaderName(v),
      },
    });
    edges.push({ a: contributorId ?? topic?.id ?? CORE_ID, b: id, kind: "video" });
    for (const code of readCodes(v)) {
      const compId = `comp:${code}`;
      if (compNodeIds.has(compId)) {
        edges.push({ a: id, b: compId, kind: "competency" });
      }
    }
  }

  return finalizeModel(topics, nodes, edges);
}

/** Minimal shape of a node/edge returned by GET /graph (server-persisted). */
export interface ServerGraphNode {
  id: string;
  kind: string;
  label: string;
  trade?: string | null;
  refId?: string | null;
  description?: string | null;
  confidence?: number | null;
  verificationStatus?: string;
  meta?: Record<string, unknown> | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ServerGraphEdge {
  id: string;
  source: string;
  target: string;
  kind: string;
  weight?: number;
  meta?: Record<string, unknown> | null;
}

function metaStr(
  meta: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  const val = meta?.[key];
  return typeof val === "string" ? val : undefined;
}

function metaNumArray(
  meta: Record<string, unknown> | null | undefined,
  key: string,
): number[] {
  const val = meta?.[key];
  return Array.isArray(val)
    ? val.filter((n): n is number => typeof n === "number")
    : [];
}

function metaStrArray(
  meta: Record<string, unknown> | null | undefined,
  key: string,
): string[] {
  const val = meta?.[key];
  return Array.isArray(val)
    ? val.filter((s): s is string => typeof s === "string")
    : [];
}

/** Parse the per-source provenance array stored on a knowledge node's meta. */
function readSources(meta: Record<string, unknown> | null | undefined): NodeSource[] {
  const raw = meta?.["sources"];
  if (!Array.isArray(raw)) return [];
  const out: NodeSource[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const videoId = typeof e["videoId"] === "string" ? e["videoId"] : null;
    if (!videoId) continue;
    out.push({
      videoId,
      timestamps: Array.isArray(e["timestamps"])
        ? (e["timestamps"] as unknown[]).filter((t): t is number => typeof t === "number")
        : [],
      confidence: typeof e["confidence"] === "number" ? e["confidence"] : 0.5,
      model: typeof e["model"] === "string" ? e["model"] : null,
      extractedAt: typeof e["extractedAt"] === "string" ? e["extractedAt"] : null,
    });
  }
  return out;
}

/** Parse the confidence-over-time log stored on a knowledge node's meta. */
function readConfidenceHistory(
  meta: Record<string, unknown> | null | undefined,
): ConfidencePoint[] {
  const raw = meta?.["confidenceHistory"];
  if (!Array.isArray(raw)) return [];
  const out: ConfidencePoint[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e["confidence"] !== "number") continue;
    out.push({
      confidence: e["confidence"],
      sourceCount: typeof e["sourceCount"] === "number" ? e["sourceCount"] : 0,
      at: typeof e["at"] === "string" ? e["at"] : "",
    });
  }
  return out;
}

/** Parse the merged-in concept ledger stored on a knowledge node's meta. */
function readMergedFrom(
  meta: Record<string, unknown> | null | undefined,
): MergedConcept[] {
  const raw = meta?.["mergedFrom"];
  if (!Array.isArray(raw)) return [];
  const out: MergedConcept[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e["id"] === "string" ? e["id"] : null;
    if (!id) continue;
    out.push({
      id,
      label: typeof e["label"] === "string" ? e["label"] : id,
      category: typeof e["category"] === "string" ? e["category"] : undefined,
      at: typeof e["at"] === "string" ? e["at"] : undefined,
    });
  }
  return out;
}

/** Parse the withdrawn-evidence ledger stored on a knowledge node's meta. */
function readRejectedEvidence(
  meta: Record<string, unknown> | null | undefined,
): RejectedEvidence[] {
  const raw = meta?.["rejectedEvidence"];
  if (!Array.isArray(raw)) return [];
  const out: RejectedEvidence[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const videoId = typeof e["videoId"] === "string" ? e["videoId"] : null;
    if (!videoId) continue;
    out.push({
      videoId,
      at: typeof e["at"] === "string" ? e["at"] : undefined,
      reason: typeof e["reason"] === "string" ? e["reason"] : undefined,
    });
  }
  return out;
}

/** Parse the human verification-decision log stored on a knowledge node's meta. */
function readVerificationHistory(
  meta: Record<string, unknown> | null | undefined,
): VerificationTransition[] {
  const raw = meta?.["verificationHistory"];
  if (!Array.isArray(raw)) return [];
  const out: VerificationTransition[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    out.push({
      from: typeof e["from"] === "string" ? e["from"] : "",
      to: typeof e["to"] === "string" ? e["to"] : "",
      at: typeof e["at"] === "string" ? e["at"] : "",
      reviewer: typeof e["reviewer"] === "string" ? e["reviewer"] : null,
    });
  }
  return out;
}

/**
 * Build the graph model from the server-persisted knowledge graph (GET /graph).
 * Colors and topic ordering stay client-side (a pure visual concern) so the
 * canvas renderer is identical whether the model comes from here or from
 * buildGraphModel(). IDs already match the client scheme, so edges map directly.
 */
export function buildGraphModelFromServer(graph: {
  nodes: ServerGraphNode[];
  edges: ServerGraphEdge[];
}): GraphModel {
  // The persisted graph carries the core/topic/competency/video scaffold *and*
  // the distilled atomic-knowledge layer (concept/tool/hazard/…) with its
  // provenance edges. Render every node whose id is present; drop only edges
  // that dangle to a missing endpoint.
  const serverNodes = graph.nodes;
  const renderedIds = new Set(serverNodes.map((n) => n.id));
  const serverEdges = graph.edges.filter(
    (e) => renderedIds.has(e.source) && renderedIds.has(e.target),
  );

  const topicNodes = serverNodes
    .filter((n) => n.kind === "topic")
    .sort((a, b) => (a.trade ?? a.label).localeCompare(b.trade ?? b.label));

  const topics: Topic[] = topicNodes.map((n, i) => ({
    id: n.id,
    trade: n.trade ?? n.label,
    label: n.label,
    color: TOPIC_PALETTE[i % TOPIC_PALETTE.length]!,
    metrics: emptyMetrics(),
  }));
  const colorByTopicId = new Map(topics.map((t) => [t.id, t.color]));
  const colorByTrade = new Map(topics.map((t) => [t.trade, t.color]));

  const nodes: MemoryNode[] = serverNodes.map((n) => {
    const trade = n.trade ?? undefined;
    const topicColor = (trade ? colorByTrade.get(trade) : undefined) ?? CORE_COLOR;

    if (n.kind === "core") {
      return { id: n.id, kind: "core", label: n.label, color: CORE_COLOR, meta: {} };
    }
    if (n.kind === "topic") {
      return {
        id: n.id,
        kind: "topic",
        label: n.label,
        topicId: n.id,
        color: colorByTopicId.get(n.id) ?? CORE_COLOR,
        meta: { trade },
      };
    }
    if (n.kind === "competency") {
      return {
        id: n.id,
        kind: "competency",
        label: n.label,
        topicId: trade ? topicIdForTrade(trade) : undefined,
        color: tint(topicColor, 0.45),
        meta: {
          trade,
          code: metaStr(n.meta, "code") ?? n.label,
          description: metaStr(n.meta, "description"),
        },
      };
    }
    if (n.kind === "video") {
      const codes = metaStrArray(n.meta, "competencyCodes");
      return {
        id: n.id,
        kind: "video",
        label: n.label,
        topicId: trade ? topicIdForTrade(trade) : undefined,
        color: topicColor,
        status: metaStr(n.meta, "status"),
        meta: {
          trade,
          description: n.description ?? metaStr(n.meta, "description"),
          createdAt: n.createdAt ?? metaStr(n.meta, "createdAt"),
          updatedAt: n.updatedAt ?? metaStr(n.meta, "updatedAt"),
          competencyCodes: codes,
        },
      };
    }
    if (n.kind === "mentor") {
      return {
        id: n.id,
        kind: "mentor",
        label: n.label,
        topicId: trade ? topicIdForTrade(trade) : undefined,
        color: MENTOR_COLOR,
        meta: {
          trade,
          description: n.description ?? metaStr(n.meta, "description"),
          createdAt: n.createdAt ?? metaStr(n.meta, "createdAt"),
          updatedAt: n.updatedAt ?? metaStr(n.meta, "updatedAt"),
        },
      };
    }
    if (n.kind === "contributor") {
      return {
        id: n.id,
        kind: "contributor",
        label: n.label,
        topicId: trade ? topicIdForTrade(trade) : undefined,
        color: CONTRIBUTOR_COLOR,
        meta: {
          trade,
          description: n.description ?? metaStr(n.meta, "description"),
          userId: metaStr(n.meta, "userId") ?? n.refId ?? undefined,
          email: metaStr(n.meta, "email"),
          name: metaStr(n.meta, "name") ?? n.label,
          createdAt: n.createdAt ?? metaStr(n.meta, "createdAt"),
          updatedAt: n.updatedAt ?? metaStr(n.meta, "updatedAt"),
        },
      };
    }
    if (isKnowledgeKind(n.kind)) {
      // Atomic knowledge: signature color by kind, clustered under its trade hub.
      const kindColor = KNOWLEDGE_KIND_META[n.kind].color;
      const sources = readSources(n.meta);
      return {
        id: n.id,
        kind: n.kind,
        label: n.label,
        topicId: trade ? topicIdForTrade(trade) : undefined,
        color: kindColor,
        meta: {
          trade,
          category: metaStr(n.meta, "category") ?? n.kind,
          refId: n.refId ?? undefined,
          description: n.description ?? metaStr(n.meta, "description"),
          confidence: typeof n.confidence === "number" ? n.confidence : undefined,
          verificationStatus: n.verificationStatus,
          sourceCount:
            typeof n.meta?.["sourceCount"] === "number"
              ? (n.meta["sourceCount"] as number)
              : sources.length,
          sourceVideoIds: metaStrArray(n.meta, "sourceVideoIds"),
          timestamps: metaNumArray(n.meta, "timestamps"),
          sources,
          aliases: metaStrArray(n.meta, "aliases"),
          models: metaStrArray(n.meta, "models"),
          firstExtractedAt: metaStr(n.meta, "firstExtractedAt"),
          lastExtractedAt: metaStr(n.meta, "lastExtractedAt"),
          confidenceHistory: readConfidenceHistory(n.meta),
          mergedFrom: readMergedFrom(n.meta),
          rejectedEvidence: readRejectedEvidence(n.meta),
          verificationHistory: readVerificationHistory(n.meta),
          createdAt: n.createdAt,
          updatedAt: n.updatedAt,
        },
      };
    }
    // Unknown kind fallback — render as a neutral node so nothing silently vanishes.
    return {
      id: n.id,
      kind: n.kind as NodeKind,
      label: n.label,
      topicId: trade ? topicIdForTrade(trade) : undefined,
      color: topicColor,
      meta: { trade, description: n.description ?? metaStr(n.meta, "description") },
    };
  });

  const edges: MemoryEdge[] = serverEdges.map((e) => ({
    a: e.source,
    b: e.target,
    kind: e.kind || "video",
    weight: typeof e.weight === "number" ? e.weight : undefined,
  }));

  return finalizeModel(topics, nodes, edges);
}

/** Loosely-typed view of the GET /graph payload as it actually arrives at
 *  runtime — the server *should* return a well-formed KnowledgeGraph, but a
 *  schema drift, partial write, or transport error can yield a truthy object
 *  that is missing its `nodes`/`edges` arrays. We must never assume they exist. */
export interface MaybeServerGraph {
  nodes?: ServerGraphNode[] | null;
  edges?: ServerGraphEdge[] | null;
}

/**
 * Choose the Living Memory model for the current data. The persisted server
 * graph wins when it actually carries nodes; otherwise we derive the graph
 * client-side from videos + competencies so the view is never blank.
 *
 * This is the single guard between a good server graph and the client fallback.
 * It tolerates any malformed payload (undefined, {}, or { nodes } without edges)
 * without throwing, so a bad GET /graph response can never blank the SPA.
 */
export function selectMemoryGraphModel(
  graph: MaybeServerGraph | null | undefined,
  videos: RawVideo[],
  competencies: RawCompetency[],
): GraphModel {
  // Only trust the server graph when it is *fully* well-formed: both `nodes` and
  // `edges` are arrays and there is at least one node. A truthy-but-malformed
  // payload (missing either array) falls back to the client-derived graph.
  if (
    Array.isArray(graph?.nodes) &&
    graph.nodes.length > 0 &&
    Array.isArray(graph?.edges)
  ) {
    return buildGraphModelFromServer({
      nodes: graph.nodes,
      edges: graph.edges,
    });
  }
  // Fallback: derive the graph client-side if the persisted graph is empty,
  // malformed, or unavailable (e.g. schema not yet applied).
  return buildGraphModel(videos, competencies);
}
