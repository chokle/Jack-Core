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
  | KnowledgeKind;

/** Signature color for mentor (human-sourced) nodes, distinct from the video and
 *  atomic-knowledge strata so mentor-supplied corroboration reads at a glance. */
export const MENTOR_COLOR: RGB = [255, 205, 120];

const KNOWLEDGE_KIND_SET = new Set<string>(KNOWLEDGE_KINDS);

export function isKnowledgeKind(kind: string): kind is KnowledgeKind {
  return KNOWLEDGE_KIND_SET.has(kind);
}

/** One source video that corroborates an atomic knowledge node. */
export interface NodeSource {
  videoId: string;
  timestamps: number[];
  confidence: number;
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
    /** Atomic-knowledge fields (present only for KnowledgeKind nodes). */
    category?: string;
    refId?: string;
    confidence?: number;
    verificationStatus?: string;
    sourceCount?: number;
    sourceVideoIds?: string[];
    timestamps?: number[];
    sources?: NodeSource[];
  };
}

export interface MemoryEdge {
  a: string;
  b: string;
  kind: string;
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
  return KNOWLEDGE_KIND_META[kind as KnowledgeKind]?.label ?? "Knowledge";
}

export interface Topic {
  id: string;
  trade: string;
  label: string;
  color: RGB;
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
      },
    });
    edges.push({ a: topic?.id ?? CORE_ID, b: id, kind: "video" });
    for (const code of readCodes(v)) {
      const compId = `comp:${code}`;
      if (compNodeIds.has(compId)) {
        edges.push({ a: id, b: compId, kind: "competency" });
      }
    }
  }

  // 6. Degree (connection count) per node.
  const degree: Record<string, number> = {};
  for (const e of edges) {
    degree[e.a] = (degree[e.a] ?? 0) + 1;
    degree[e.b] = (degree[e.b] ?? 0) + 1;
  }

  return {
    topics,
    nodes,
    edges,
    degree,
    counts: {
      nodes: nodes.length,
      connections: edges.length,
      topics: topics.length,
      videos: videos.length,
      knowledge: nodes.filter((n) => isKnowledgeKind(n.kind)).length,
    },
  };
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
  }));

  const degree: Record<string, number> = {};
  for (const e of edges) {
    degree[e.a] = (degree[e.a] ?? 0) + 1;
    degree[e.b] = (degree[e.b] ?? 0) + 1;
  }

  const videos = nodes.filter((n) => n.kind === "video").length;
  const knowledge = nodes.filter((n) => isKnowledgeKind(n.kind)).length;

  return {
    topics,
    nodes,
    edges,
    degree,
    counts: {
      nodes: nodes.length,
      connections: edges.length,
      topics: topics.length,
      videos,
      knowledge,
    },
  };
}
