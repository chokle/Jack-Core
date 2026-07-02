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
  Play,
  ShieldCheck,
  ShieldAlert,
  ShieldQuestion,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useSetNodeVerification,
  getGetGraphQueryKey,
} from "@workspace/api-client-react";
import type { VerificationUpdateStatus } from "@workspace/api-client-react";
import {
  MemoryGraphCanvas,
  type MemoryGraphHandle,
} from "./MemoryGraphCanvas";
import { PendingKnowledgePanel } from "./PendingKnowledgePanel";
import type { MemoryGraphData } from "../lib/use-memory-graph";
import {
  rgbCss,
  rgba,
  timeAgo,
  readCreatedAt,
  isKnowledgeKind,
  kindLabel as kindLabelFor,
  KNOWLEDGE_KIND_META,
  type MemoryNode,
  type NodeSource,
  type RGB,
} from "../lib/memory-graph";

interface MemoryGraphViewProps {
  data: MemoryGraphData;
  onOpenVideo: (id: string) => void;
  /** Open a source video and seek to a transcript timestamp (seconds). */
  onJumpToTimestamp: (videoId: string, startTime: number) => void;
}

const STATUS_COLOR: Record<string, RGB> = {
  ready: [99, 214, 142],
  error: [239, 90, 90],
  pending: [245, 197, 66],
  transcribing: [245, 197, 66],
  analyzing: [245, 197, 66],
};

export function MemoryGraphView({
  data,
  onOpenVideo,
  onJumpToTimestamp,
}: MemoryGraphViewProps) {
  const { model, recent, competencies } = data;
  const canvasRef = useRef<MemoryGraphHandle>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [locked, setLocked] = useState(false);
  const [zoomPct, setZoomPct] = useState(100);
  const [showLegend, setShowLegend] = useState(true);

  // Reviewers with a valid admin session can verify/reject distilled concepts.
  // We reuse the same signed session that gates library ingestion; the PATCH
  // route is admin-only on the server, this just hides the controls otherwise.
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch("/api/admin/session", { credentials: "include" })
      .then((res) => res.json() as Promise<{ authenticated?: boolean }>)
      .then((body) => {
        if (alive) setIsAdmin(Boolean(body.authenticated));
      })
      .catch(() => {
        if (alive) setIsAdmin(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const queryClient = useQueryClient();
  const setVerification = useSetNodeVerification({
    request: { credentials: "include" },
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getGetGraphQueryKey() });
      },
    },
  });

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

  const adjacency = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const e of model.edges) {
      if (!m.has(e.a)) m.set(e.a, new Set());
      if (!m.has(e.b)) m.set(e.b, new Set());
      m.get(e.a)!.add(e.b);
      m.get(e.b)!.add(e.a);
    }
    return m;
  }, [model]);

  const compByCode = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of competencies) m.set(c.code, c.name);
    return m;
  }, [competencies]);

  // Knowledge kinds actually present in the graph, for the legend.
  const presentKnowledgeKinds = useMemo(() => {
    const seen = new Set<string>();
    for (const n of model.nodes) if (isKnowledgeKind(n.kind)) seen.add(n.kind);
    return (Object.keys(KNOWLEDGE_KIND_META) as (keyof typeof KNOWLEDGE_KIND_META)[])
      .filter((k) => seen.has(k))
      .map((k) => ({ kind: k, ...KNOWLEDGE_KIND_META[k] }));
  }, [model]);

  // Index: which knowledge nodes cite each source video, so the inspector can
  // surface concepts co-taught alongside the selected one.
  const knowledgeByVideoId = useMemo(() => {
    const m = new Map<string, MemoryNode[]>();
    for (const n of model.nodes) {
      if (!isKnowledgeKind(n.kind)) continue;
      for (const s of n.meta.sources ?? []) {
        if (!m.has(s.videoId)) m.set(s.videoId, []);
        m.get(s.videoId)!.push(n);
      }
    }
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
            {presentKnowledgeKinds.length > 0 && (
              <>
                <div className="mb-2 mt-3 font-mono text-[10px] uppercase tracking-[0.18em] text-white/50">
                  Knowledge
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                  {presentKnowledgeKinds.map((k) => (
                    <div key={k.kind} className="flex items-center gap-1.5">
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{
                          background: rgbCss(k.color),
                          boxShadow: `0 0 6px ${rgba(k.color, 0.8)}`,
                        }}
                      />
                      <span className="text-xs text-white/75">{k.label}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
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
        <KnowledgeInspector
          node={selected}
          degree={selected ? model.degree[selected.id] ?? 0 : 0}
          relatedVideoCount={relatedVideoCount(selected, model)}
          nodeById={nodeById}
          adjacency={adjacency}
          knowledgeByVideoId={knowledgeByVideoId}
          compByCode={compByCode}
          onOpenVideo={onOpenVideo}
          onJumpToTimestamp={onJumpToTimestamp}
          onSelectNode={setSelectedId}
          isAdmin={isAdmin}
          isUpdatingVerification={setVerification.isPending}
          onSetVerification={(id, status) =>
            setVerification.mutate({ id, data: { status } })
          }
        />
        {selected && !isKnowledgeKind(selected.kind) && (
          <RelatedCompetencies node={selected} competencies={competencies} />
        )}
        <PendingKnowledgePanel />
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

const VERIFICATION_META: Record<
  string,
  { label: string; color: RGB; Icon: typeof ShieldCheck }
> = {
  verified: { label: "Verified", color: [99, 214, 142], Icon: ShieldCheck },
  unverified: { label: "Unverified", color: [245, 197, 66], Icon: ShieldQuestion },
  rejected: { label: "Rejected", color: [239, 90, 90], Icon: ShieldAlert },
};

function formatTimestamp(sec: number): string {
  const t = Number.isFinite(sec) && sec > 0 ? sec : 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function KnowledgeInspector({
  node,
  degree,
  relatedVideoCount,
  nodeById,
  adjacency,
  knowledgeByVideoId,
  compByCode,
  onOpenVideo,
  onJumpToTimestamp,
  onSelectNode,
  isAdmin,
  isUpdatingVerification,
  onSetVerification,
}: {
  node: MemoryNode | null;
  degree: number;
  relatedVideoCount: number;
  nodeById: Map<string, MemoryNode>;
  adjacency: Map<string, Set<string>>;
  knowledgeByVideoId: Map<string, MemoryNode[]>;
  compByCode: Map<string, string>;
  onOpenVideo: (id: string) => void;
  onJumpToTimestamp: (videoId: string, startTime: number) => void;
  onSelectNode: (id: string) => void;
  isAdmin: boolean;
  isUpdatingVerification: boolean;
  onSetVerification: (id: string, status: VerificationUpdateStatus) => void;
}) {
  if (!node) {
    return (
      <Panel title="Knowledge Inspector">
        <p className="text-xs text-muted-foreground">
          Click any node in the graph to inspect what Jack knows about it.
        </p>
      </Panel>
    );
  }

  const knowledge = isKnowledgeKind(node.kind);
  const kLabel = kindLabelFor(node.kind);

  const subtitle =
    node.kind === "core"
      ? undefined
      : knowledge
        ? node.meta.trade
          ? `${kLabel} · ${node.meta.trade}`
          : kLabel
        : node.meta.trade;

  const description =
    node.meta.description ??
    (node.kind === "video"
      ? node.status === "ready"
        ? "Transcribed and indexed into Jack's memory."
        : `Currently ${node.status ?? "queued"} — Jack is still learning from this.`
      : node.kind === "topic"
        ? "A cluster of Jack's knowledge for this trade."
        : node.kind === "core"
          ? "The core of Jack's living memory."
          : "An atomic unit of knowledge distilled from Jack's videos.");

  const confidence =
    typeof node.meta.confidence === "number"
      ? Math.max(0, Math.min(1, node.meta.confidence))
      : undefined;

  const verifyKey = (node.meta.verificationStatus ?? "").toLowerCase();
  const verify = VERIFICATION_META[verifyKey];

  const sources: NodeSource[] = knowledge ? node.meta.sources ?? [] : [];

  // Concepts co-taught with this one (share ≥1 source video).
  const related: { node: MemoryNode; shared: number }[] = [];
  if (knowledge) {
    const counts = new Map<string, { node: MemoryNode; shared: number }>();
    for (const s of sources) {
      for (const kn of knowledgeByVideoId.get(s.videoId) ?? []) {
        if (kn.id === node.id) continue;
        const cur = counts.get(kn.id);
        if (cur) cur.shared += 1;
        else counts.set(kn.id, { node: kn, shared: 1 });
      }
    }
    related.push(
      ...[...counts.values()].sort((a, b) => b.shared - a.shared).slice(0, 8),
    );
  } else {
    for (const id of adjacency.get(node.id) ?? []) {
      const n = nodeById.get(id);
      if (n && n.kind !== "core") related.push({ node: n, shared: 0 });
      if (related.length >= 10) break;
    }
  }

  // Competencies directly linked to a knowledge node (via competency edges).
  const linkedComps: { code: string; name: string }[] = [];
  if (knowledge) {
    for (const id of adjacency.get(node.id) ?? []) {
      if (!id.startsWith("comp:")) continue;
      const code = nodeById.get(id)?.meta.code ?? id.replace("comp:", "");
      linkedComps.push({ code, name: compByCode.get(code) ?? "" });
    }
  }

  return (
    <Panel title="Knowledge Inspector">
      <div className="mb-3 flex items-start gap-2.5">
        <span
          className="mt-1 h-3 w-3 shrink-0 rounded-full"
          style={{
            background: rgbCss(node.color),
            boxShadow: `0 0 8px ${rgba(node.color, 0.9)}`,
          }}
        />
        <div className="min-w-0">
          <div className="text-sm font-semibold leading-snug text-foreground">
            {node.label}
          </div>
          <div className="text-xs" style={{ color: rgba(node.color, 0.95) }}>
            {subtitle ?? kLabel}
          </div>
        </div>
      </div>

      <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
        {description}
      </p>

      {knowledge && confidence !== undefined && (
        <div className="mb-3">
          <div className="mb-1 flex items-center justify-between text-[11px]">
            <span className="text-muted-foreground">Confidence</span>
            <span className="font-mono font-semibold tabular-nums text-foreground">
              {Math.round(confidence * 100)}%
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.round(confidence * 100)}%`,
                background: rgbCss(node.color),
              }}
            />
          </div>
        </div>
      )}

      <div className="divide-y divide-border/60 border-y border-border/60">
        {knowledge && (
          <Row
            label="Knowledge ID"
            value={
              <span className="max-w-[10rem] truncate" title={node.meta.refId ?? node.id}>
                {node.meta.refId ?? node.id}
              </span>
            }
          />
        )}
        {knowledge && verify && (
          <Row
            label="Verification"
            value={
              <span
                className="inline-flex items-center gap-1"
                style={{ color: rgbCss(verify.color) }}
              >
                <verify.Icon className="h-3.5 w-3.5" />
                {verify.label}
              </span>
            }
          />
        )}
        {knowledge && sources.length > 0 && (
          <Row label="Sources" value={node.meta.sourceCount ?? sources.length} />
        )}
        <Row label="Connections" value={degree} />
        {(node.kind === "video" || node.kind === "competency") && (
          <Row label="Related Videos" value={relatedVideoCount} />
        )}
        {node.kind === "topic" && <Row label="Videos" value={relatedVideoCount} />}
        {node.meta.updatedAt && (
          <Row label="Last Updated" value={timeAgo(node.meta.updatedAt)} />
        )}
        {node.kind === "competency" && node.meta.code && (
          <Row label="Code" value={node.meta.code} />
        )}
      </div>

      {knowledge && isAdmin && (
        <div className="mt-3">
          <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Review
          </div>
          <div className="flex gap-1.5">
            {(
              [
                { status: "verified", label: "Verify", Icon: ShieldCheck, color: [99, 214, 142] as RGB },
                { status: "rejected", label: "Reject", Icon: ShieldAlert, color: [239, 90, 90] as RGB },
                { status: "unverified", label: "Reset", Icon: ShieldQuestion, color: [245, 197, 66] as RGB },
              ] satisfies { status: VerificationUpdateStatus; label: string; Icon: typeof ShieldCheck; color: RGB }[]
            ).map(({ status, label, Icon, color }) => {
              const active = verifyKey === status;
              return (
                <button
                  key={status}
                  disabled={isUpdatingVerification || active}
                  onClick={() => onSetVerification(node.id, status)}
                  className="flex flex-1 items-center justify-center gap-1 rounded-lg border px-2 py-1.5 text-[11px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                  style={{
                    borderColor: rgba(color, active ? 0.9 : 0.35),
                    color: rgbCss(color),
                    background: active ? rgba(color, 0.18) : "transparent",
                  }}
                  title={active ? `Already ${label.toLowerCase()}ed` : label}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {knowledge && sources.length > 0 && (
        <div className="mt-3">
          <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Source Videos
          </div>
          <ul className="space-y-2.5">
            {sources.map((s) => {
              const vNode = nodeById.get(`video:${s.videoId}`);
              const title = vNode?.label ?? "Untitled video";
              const stamps = s.timestamps.length ? s.timestamps : [0];
              return (
                <li key={s.videoId}>
                  <button
                    onClick={() => onOpenVideo(s.videoId)}
                    className="block w-full truncate text-left text-xs font-medium text-foreground hover:text-primary"
                    title={title}
                  >
                    {title}
                  </button>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {stamps.map((t, i) => (
                      <button
                        key={`${t}-${i}`}
                        onClick={() => onJumpToTimestamp(s.videoId, t)}
                        className="inline-flex items-center gap-1 rounded-md bg-primary/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-primary transition-colors hover:bg-primary/25"
                      >
                        <Play className="h-2.5 w-2.5" />
                        {formatTimestamp(t)}
                      </button>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {knowledge && linkedComps.length > 0 && (
        <div className="mt-3">
          <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Competencies
          </div>
          <div className="flex flex-wrap gap-1.5">
            {linkedComps.map((c) => (
              <button
                key={c.code}
                onClick={() => onSelectNode(`comp:${c.code}`)}
                className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-primary/20 hover:text-primary"
                title={c.name}
              >
                {c.code}
                {c.name ? ` · ${c.name}` : ""}
              </button>
            ))}
          </div>
        </div>
      )}

      {related.length > 0 && (
        <div className="mt-3">
          <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Related Nodes
          </div>
          <div className="flex flex-wrap gap-1.5">
            {related.map(({ node: rn, shared }) => (
              <button
                key={rn.id}
                onClick={() => onSelectNode(rn.id)}
                className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-black/30 px-2 py-0.5 text-[11px] font-medium text-white/80 transition-colors hover:border-primary/50 hover:text-primary"
                title={shared > 0 ? `Shares ${shared} source${shared === 1 ? "" : "s"}` : kindLabelFor(rn.kind)}
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: rgbCss(rn.color) }}
                />
                <span className="max-w-[8rem] truncate">{rn.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}

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
