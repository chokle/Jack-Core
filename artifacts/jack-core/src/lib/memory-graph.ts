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

export type NodeKind = "core" | "topic" | "video" | "competency";

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
  };
}

export interface MemoryEdge {
  a: string;
  b: string;
  kind: NodeKind;
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
  counts: { nodes: number; connections: number; topics: number; videos: number };
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
    },
  };
}
