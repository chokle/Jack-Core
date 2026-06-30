import { useEffect, useMemo, useRef, useState } from "react";
import {
  Search,
  SlidersHorizontal,
  Crosshair,
  Maximize2,
  Plus,
  Minus,
  Lock,
  Unlock,
  ArrowUpRight,
  Activity,
} from "lucide-react";
import {
  MemoryGraphCanvas,
  type MemoryGraphHandle,
} from "./MemoryGraphCanvas";
import type { MemoryGraphData } from "../lib/use-memory-graph";
import {
  rgbCss,
  rgba,
  timeAgo,
  readCreatedAt,
  type MemoryNode,
  type RGB,
} from "../lib/memory-graph";

interface MemoryGraphViewProps {
  data: MemoryGraphData;
  onOpenVideo: (id: string) => void;
}

const STATUS_COLOR: Record<string, RGB> = {
  ready: [99, 214, 142],
  error: [239, 90, 90],
  pending: [245, 197, 66],
  transcribing: [245, 197, 66],
  analyzing: [245, 197, 66],
};

export function MemoryGraphView({ data, onOpenVideo }: MemoryGraphViewProps) {
  const { model, recent, competencies } = data;
  const canvasRef = useRef<MemoryGraphHandle>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [locked, setLocked] = useState(false);
  const [zoomPct, setZoomPct] = useState(100);
  const [showLegend, setShowLegend] = useState(true);

  const nodeById = useMemo(() => {
    const m = new Map<string, MemoryNode>();
    for (const n of model.nodes) m.set(n.id, n);
    return m;
  }, [model]);

  const colorByTrade = useMemo(() => {
    const m = new Map<string, RGB>();
    for (const t of model.topics) m.set(t.trade, t.color);
    return m;
  }, [model]);

  useEffect(() => {
    if (selectedId && !nodeById.has(selectedId)) setSelectedId(null);
  }, [selectedId, nodeById]);

  const selected = selectedId ? nodeById.get(selectedId) ?? null : null;

  const toggleFullscreen = () => {
    const el = containerRef.current;
    if (!document.fullscreenElement) el?.requestFullscreen?.().catch(() => {});
    else document.exitFullscreen?.().catch(() => {});
  };

  return (
    <div ref={containerRef} className="relative flex flex-1 overflow-hidden bg-[rgb(7,10,20)]">
      {/* Graph stage */}
      <div className="relative flex-1 overflow-hidden">
        <MemoryGraphCanvas
          ref={canvasRef}
          model={model}
          selectedId={selectedId}
          onSelect={setSelectedId}
          search={search}
          locked={locked}
          onZoomChange={setZoomPct}
        />

        {/* Header overlay */}
        <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-col gap-4 p-6 lg:flex-row lg:items-start lg:justify-between">
          <div className="pointer-events-none">
            <h1 className="text-2xl font-extrabold tracking-tight text-white drop-shadow">
              JACK'S LIVING MEMORY
            </h1>
            <p className="mt-1 font-mono text-xs text-white/55">
              Every connection is knowledge. Every node is experience.
            </p>
          </div>
          <div className="pointer-events-auto flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search the graph..."
                className="h-9 w-56 rounded-lg border border-white/10 bg-black/40 pl-9 pr-3 text-sm text-white outline-none backdrop-blur placeholder:text-white/40 focus:border-primary/60"
              />
            </div>
            <IconButton
              title={showLegend ? "Hide legend" : "Show legend"}
              active={showLegend}
              onClick={() => setShowLegend((v) => !v)}
            >
              <SlidersHorizontal className="h-4 w-4" />
            </IconButton>
            <IconButton title="Recenter" onClick={() => canvasRef.current?.reset()}>
              <Crosshair className="h-4 w-4" />
            </IconButton>
            <IconButton title="Fullscreen" onClick={toggleFullscreen}>
              <Maximize2 className="h-4 w-4" />
            </IconButton>
          </div>
        </div>

        {/* Legend */}
        {showLegend && model.topics.length > 0 && (
          <div className="absolute bottom-6 left-6 max-w-[60%] rounded-xl border border-white/10 bg-black/45 p-3 backdrop-blur">
            <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-white/50">
              Legend
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {model.topics.map((t) => (
                <div key={t.id} className="flex items-center gap-1.5">
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{
                      background: rgbCss(t.color),
                      boxShadow: `0 0 6px ${rgba(t.color, 0.8)}`,
                    }}
                  />
                  <span className="text-xs text-white/75">{t.label}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Zoom controls */}
        <div className="absolute bottom-6 right-6 flex items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-black/45 p-1 backdrop-blur">
            <IconButton title="Zoom out" onClick={() => canvasRef.current?.zoomOut()}>
              <Minus className="h-4 w-4" />
            </IconButton>
            <span className="w-12 text-center font-mono text-xs tabular-nums text-white/80">
              {zoomPct}%
            </span>
            <IconButton title="Zoom in" onClick={() => canvasRef.current?.zoomIn()}>
              <Plus className="h-4 w-4" />
            </IconButton>
          </div>
          <IconButton
            title={locked ? "Unlock view" : "Lock view"}
            active={locked}
            onClick={() => setLocked((v) => !v)}
          >
            {locked ? <Lock className="h-4 w-4" /> : <Unlock className="h-4 w-4" />}
          </IconButton>
        </div>
      </div>

      {/* Right rail */}
      <aside className="hidden w-80 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border bg-sidebar/85 p-4 backdrop-blur-md lg:flex">
        <LiveFeed
          recent={recent}
          colorByTrade={colorByTrade}
          onSelect={(id) => setSelectedId(`video:${id}`)}
        />
        <SelectedNodePanel
          node={selected}
          degree={selected ? model.degree[selected.id] ?? 0 : 0}
          relatedVideoCount={relatedVideoCount(selected, model)}
          onOpenVideo={onOpenVideo}
        />
        <RelatedCompetencies node={selected} competencies={competencies} />
      </aside>
    </div>
  );
}

function relatedVideoCount(
  node: MemoryNode | null,
  model: MemoryGraphData["model"],
): number {
  if (!node) return 0;
  if (node.kind === "competency") return node.meta.videoCount ?? 0;
  const trade = node.meta.trade;
  if (!trade) return 0;
  let n = 0;
  for (const x of model.nodes) {
    if (x.kind === "video" && x.meta.trade === trade) n++;
  }
  if (node.kind === "video") return Math.max(0, n - 1);
  return n;
}

function IconButton({
  children,
  onClick,
  title,
  active,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  title?: string;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`flex h-8 w-8 items-center justify-center rounded-md border backdrop-blur transition-colors ${
        active
          ? "border-primary/50 bg-primary/20 text-primary"
          : "border-white/10 bg-black/40 text-white/70 hover:bg-white/10 hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}

function Panel({
  title,
  badge,
  children,
}: {
  title: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card/40 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          {title}
        </h2>
        {badge}
      </div>
      {children}
    </section>
  );
}

function LiveFeed({
  recent,
  colorByTrade,
  onSelect,
}: {
  recent: MemoryGraphData["recent"];
  colorByTrade: Map<string, RGB>;
  onSelect: (id: string) => void;
}) {
  return (
    <Panel
      title="Recent Knowledge Added"
      badge={
        <span className="flex items-center gap-1 font-mono text-[10px] font-semibold text-emerald-400">
          <Activity className="h-3 w-3" /> LIVE FEED
        </span>
      }
    >
      {recent.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No memories yet — ingest a video to start growing the graph.
        </p>
      ) : (
        <ul className="space-y-3">
          {recent.slice(0, 6).map((v) => {
            const trade = v.trade ?? undefined;
            const col = (trade && colorByTrade.get(trade)) || [255, 134, 38];
            return (
              <li key={v.id}>
                <button
                  onClick={() => onSelect(v.id)}
                  className="group flex w-full items-start gap-2.5 text-left"
                >
                  <span
                    className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
                    style={{
                      background: rgbCss(col),
                      boxShadow: `0 0 6px ${rgba(col, 0.9)}`,
                    }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground group-hover:text-primary">
                      {v.title ?? "Untitled"}
                    </span>
                    <span className="flex items-center justify-between gap-2">
                      <span
                        className="truncate text-xs"
                        style={{ color: rgba(col, 0.9) }}
                      >
                        {trade ?? "Uncategorized"}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                        {timeAgo(readCreatedAt(v))}
                      </span>
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono font-semibold tabular-nums">{value}</span>
    </div>
  );
}

function SelectedNodePanel({
  node,
  degree,
  relatedVideoCount,
  onOpenVideo,
}: {
  node: MemoryNode | null;
  degree: number;
  relatedVideoCount: number;
  onOpenVideo: (id: string) => void;
}) {
  if (!node) {
    return (
      <Panel title="Selected Node">
        <p className="text-xs text-muted-foreground">
          Click any node in the graph to inspect what Jack knows about it.
        </p>
      </Panel>
    );
  }

  const kindLabel =
    node.kind === "core"
      ? "Memory Core"
      : node.kind === "topic"
        ? "Topic Hub"
        : node.kind === "competency"
          ? "Red Seal Competency"
          : "Memory · Video";

  const subtitle =
    node.kind === "competency"
      ? node.meta.trade
      : node.kind === "video" || node.kind === "topic"
        ? node.meta.trade
        : undefined;

  const description =
    node.meta.description ??
    (node.kind === "video"
      ? node.status === "ready"
        ? "Transcribed and indexed into Jack's memory."
        : `Currently ${node.status ?? "queued"} — Jack is still learning from this.`
      : node.kind === "topic"
        ? "A cluster of Jack's knowledge for this trade."
        : "The core of Jack's living memory.");

  return (
    <Panel title="Selected Node">
      <div className="mb-3 flex items-start gap-2.5">
        <span
          className="mt-1 h-3 w-3 shrink-0 rounded-full"
          style={{
            background: rgbCss(node.color),
            boxShadow: `0 0 8px ${rgba(node.color, 0.9)}`,
          }}
        />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-foreground">
            {node.label}
          </div>
          <div className="text-xs" style={{ color: rgba(node.color, 0.95) }}>
            {subtitle ?? kindLabel}
          </div>
        </div>
      </div>

      <p className="mb-3 line-clamp-4 text-xs leading-relaxed text-muted-foreground">
        {description}
      </p>

      <div className="divide-y divide-border/60 border-t border-border/60">
        <Row label="Connections" value={degree} />
        {(node.kind === "video" || node.kind === "competency") && (
          <Row label="Related Videos" value={relatedVideoCount} />
        )}
        {node.kind === "topic" && (
          <Row label="Videos" value={relatedVideoCount} />
        )}
        {node.meta.updatedAt && (
          <Row label="Last Updated" value={timeAgo(node.meta.updatedAt)} />
        )}
        {node.kind === "competency" && node.meta.code && (
          <Row label="Code" value={node.meta.code} />
        )}
      </div>

      {node.kind === "video" && (
        <button
          onClick={() => onOpenVideo(node.id.replace("video:", ""))}
          className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg bg-primary/15 py-2 text-xs font-semibold text-primary transition-colors hover:bg-primary/25"
        >
          Open video <ArrowUpRight className="h-3.5 w-3.5" />
        </button>
      )}
    </Panel>
  );
}

function RelatedCompetencies({
  node,
  competencies,
}: {
  node: MemoryNode | null;
  competencies: MemoryGraphData["competencies"];
}) {
  const trade = node?.meta.trade;
  const mapped = new Set(node?.meta.competencyCodes ?? []);

  let list = trade
    ? competencies.filter((c) => c.trade === trade)
    : [...competencies].sort((a, b) => (b.videoCount ?? 0) - (a.videoCount ?? 0));

  // Surface the ones this node actually maps to first.
  list = [...list].sort(
    (a, b) => Number(mapped.has(b.code)) - Number(mapped.has(a.code)),
  );
  list = list.slice(0, 6);

  return (
    <Panel title="Related Competencies">
      {list.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No competencies linked yet.
        </p>
      ) : (
        <ul className="space-y-2">
          {list.map((c) => (
            <li
              key={c.code}
              className="flex items-center justify-between gap-2"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-foreground">
                  {c.code} · {c.name}
                </span>
              </span>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold ${
                  mapped.has(c.code)
                    ? "bg-primary/20 text-primary"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {mapped.has(c.code)
                  ? "mapped"
                  : `${c.videoCount ?? 0} vid${(c.videoCount ?? 0) === 1 ? "" : "s"}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
