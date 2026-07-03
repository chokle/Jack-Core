import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Search,
  SlidersHorizontal,
  Crosshair,
  Maximize2,
  Plus,
  Minus,
  Lock,
  Unlock,
  ExternalLink,
  Activity,
  Play,
  Pin,
  PinOff,
  ShieldCheck,
  ShieldAlert,
  ShieldQuestion,
  UserCheck,
  ChevronRight,
  ArrowUp,
  ArrowDown,
  CornerDownLeft,
  X,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useSetNodeVerification,
  useGetVideo,
  getGetVideoQueryKey,
  getGetGraphQueryKey,
} from "@workspace/api-client-react";
import type { VerificationUpdateStatus } from "@workspace/api-client-react";
import {
  MemoryGraphCanvas,
  type MemoryGraphHandle,
} from "./MemoryGraphCanvas";
import { FloatingNodeInspector } from "./FloatingNodeInspector";
import { PendingKnowledgePanel } from "./PendingKnowledgePanel";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "./ui/breadcrumb";
import type { MemoryGraphData } from "../lib/use-memory-graph";
import {
  rgbCss,
  rgba,
  timeAgo,
  readCreatedAt,
  isKnowledgeKind,
  kindLabel as kindLabelFor,
  nodeFreshness,
  KNOWLEDGE_KIND_META,
  CORE_ID,
  type MemoryNode,
  type NodeSource,
  type RGB,
  type FreshnessInfo,
  type ClusterMetrics,
} from "../lib/memory-graph";

interface MemoryGraphViewProps {
  data: MemoryGraphData;
  onOpenVideo: (id: string) => void;
  /** Open a source video and seek to a transcript timestamp (seconds). */
  onJumpToTimestamp: (videoId: string, startTime: number) => void;
}

/**
 * True on desktop-width viewports (Tailwind `sm`+). Drives the inspector layout:
 * a contextual card anchored to the node on desktop, a bottom sheet on mobile.
 */
function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(min-width: 768px)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const onChange = () => setIsDesktop(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return isDesktop;
}

export function MemoryGraphView({
  data,
  onOpenVideo,
  onJumpToTimestamp,
}: MemoryGraphViewProps) {
  const { model, recent, competencies } = data;
  const canvasRef = useRef<MemoryGraphHandle>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // The graph stage is the positioning context for the floating hover preview,
  // which we anchor to the hovered node and keep there as the sim drifts.
  const stageRef = useRef<HTMLDivElement>(null);
  const hoverCardRef = useRef<HTMLDivElement>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => new Set());
  const [search, setSearch] = useState("");
  const [locked, setLocked] = useState(false);
  const [zoomPct, setZoomPct] = useState(100);
  const [showLegend, setShowLegend] = useState(true);
  const isDesktop = useIsDesktop();

  // Search: which nodes match, and an arrow-key "cursor" over them. Typing dims
  // everything else on the canvas; Enter jumps to the active match and opens it.
  const [activeMatch, setActiveMatch] = useState(0);
  const query = search.trim().toLowerCase();

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

  // Per-topic cluster rollups (knowledge/video/mentor/… counts), keyed by the
  // topic hub node id, for the hover preview and inspector cluster summary.
  const metricsByTopicId = useMemo(() => {
    const m = new Map<string, ClusterMetrics>();
    for (const t of model.topics) m.set(t.id, t.metrics);
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

  // Nodes whose label matches the search, ranked (exact > prefix > substring,
  // then by connectedness) and capped so the arrow-key cursor stays snappy.
  const matchIds = useMemo(() => {
    if (!query) return [] as string[];
    const scored: { id: string; score: number }[] = [];
    for (const n of model.nodes) {
      if (n.kind === "core") continue;
      const label = n.label.toLowerCase();
      const at = label.indexOf(query);
      if (at === -1) continue;
      let score = label === query ? 3 : at === 0 ? 2 : 1;
      score += Math.min(1, (model.degree[n.id] ?? 0) / 20);
      scored.push({ id: n.id, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 60).map((s) => s.id);
  }, [query, model]);

  // Reset the cursor to the top result whenever the query changes.
  useEffect(() => {
    setActiveMatch(0);
  }, [query]);

  const activeMatchId =
    matchIds.length > 0
      ? matchIds[Math.min(activeMatch, matchIds.length - 1)] ?? null
      : null;

  const onSearchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // Escape clears the search first (and stops bubbling so the window-level
      // Escape doesn't ALSO close the inspector). A second Escape on an empty
      // field falls through to that listener as a familiar exit.
      if (e.key === "Escape") {
        if (search) {
          e.preventDefault();
          e.stopPropagation();
          setSearch("");
        }
        return;
      }
      if (matchIds.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveMatch((i) => (i + 1) % matchIds.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveMatch((i) => (i - 1 + matchIds.length) % matchIds.length);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const id = matchIds[Math.min(activeMatch, matchIds.length - 1)];
        if (id) {
          setSelectedId(id);
          canvasRef.current?.focusNode(id);
        }
      }
    },
    [matchIds, activeMatch, search],
  );

  // Drop selection / hover / pins that point at nodes no longer in the graph.
  useEffect(() => {
    if (selectedId && !nodeById.has(selectedId)) setSelectedId(null);
    if (hoveredId && !nodeById.has(hoveredId)) setHoveredId(null);
    setPinnedIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (nodeById.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [selectedId, hoveredId, nodeById]);

  const selected = selectedId ? nodeById.get(selectedId) ?? null : null;
  const hovered = hoveredId ? nodeById.get(hoveredId) ?? null : null;

  // Breadcrumb trail for the current selection: Jack › Trade hub › Node. Each
  // crumb is a live node the reviewer can jump back to, so exploration always
  // has an "up" path even after diving deep into a cluster.
  const trail = useMemo(() => {
    if (!selected) return [] as { id: string; label: string }[];
    const items: { id: string; label: string }[] = [{ id: CORE_ID, label: "Jack" }];
    if (selected.kind !== "core") {
      const topicId = selected.topicId;
      if (topicId && topicId !== selected.id) {
        const t = nodeById.get(topicId);
        if (t) items.push({ id: t.id, label: t.label });
      }
      items.push({ id: selected.id, label: selected.label });
    }
    return items;
  }, [selected, nodeById]);

  const togglePin = useCallback((id: string) => {
    setPinnedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Escape closes the inspector — a familiar, always-available exit.
  useEffect(() => {
    if (!selectedId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId]);

  // Anchor the lightweight hover preview to the hovered node and follow it live.
  // Positioned imperatively (transform on a ref) so node drift never re-renders
  // React. Suppressed while the inspector is open to avoid clutter.
  useEffect(() => {
    if (!hoveredId || selectedId) return;
    let raf = 0;
    const place = () => {
      const el = hoverCardRef.current;
      const stage = stageRef.current;
      const pos = canvasRef.current?.getScreenPos(hoveredId);
      if (el && stage) {
        if (pos) {
          const sw = stage.clientWidth;
          const sh = stage.clientHeight;
          const w = el.offsetWidth;
          const h = el.offsetHeight;
          let left = pos.x - w / 2;
          left = Math.max(8, Math.min(left, Math.max(8, sw - w - 8)));
          let top = pos.y - pos.r - h - 10;
          if (top < 8) top = pos.y + pos.r + 10;
          top = Math.max(8, Math.min(top, Math.max(8, sh - h - 8)));
          el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
          el.style.visibility = "visible";
        } else {
          el.style.visibility = "hidden";
        }
      }
      raf = requestAnimationFrame(place);
    };
    raf = requestAnimationFrame(place);
    return () => cancelAnimationFrame(raf);
  }, [hoveredId, selectedId]);

  // Gently pan a freshly-selected node into view when it sits too close to an
  // edge (the canvas no-ops when it's already comfortably framed), so following
  // a search hit or breadcrumb never leaves the target under the inspector.
  useEffect(() => {
    if (!selectedId) return;
    canvasRef.current?.ensureVisible(selectedId);
  }, [selectedId]);

  const toggleFullscreen = () => {
    const el = containerRef.current;
    if (!document.fullscreenElement) el?.requestFullscreen?.().catch(() => {});
    else document.exitFullscreen?.().catch(() => {});
  };

  // Detail props shared by the desktop floating card and the mobile bottom sheet.
  const detailProps: NodeDetailProps | null = selected
    ? {
        node: selected,
        degree: model.degree[selected.id] ?? 0,
        videoCount: inspectorVideoCount(selected, model),
        relatedVideoCount: relatedVideoCount(selected, model),
        clusterMetrics:
          selected.kind === "topic"
            ? metricsByTopicId.get(selected.id)
            : undefined,
        nodeById,
        adjacency,
        knowledgeByVideoId,
        compByCode,
        competencies,
        onOpenVideo,
        onJumpToTimestamp,
        onSelectNode: setSelectedId,
        isAdmin,
        isUpdatingVerification: setVerification.isPending,
        onSetVerification: (id, status) =>
          setVerification.mutate({ id, data: { status } }),
      }
    : null;

  return (
    <div ref={containerRef} className="relative flex flex-1 overflow-hidden bg-[rgb(7,10,20)]">
      {/* Graph stage */}
      <div ref={stageRef} className="relative flex-1 overflow-hidden">
        <MemoryGraphCanvas
          ref={canvasRef}
          model={model}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onHover={setHoveredId}
          onTogglePin={togglePin}
          pinnedIds={pinnedIds}
          search={search}
          activeMatchId={activeMatchId}
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
              Click any node for its full capture · double-click to pin
            </p>
          </div>
          <div className="pointer-events-auto flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={onSearchKeyDown}
                placeholder="Search the graph..."
                className="h-9 w-56 rounded-lg border border-white/10 bg-black/40 pl-9 pr-16 text-sm text-white outline-none backdrop-blur placeholder:text-white/40 focus:border-primary/60"
              />
              {query && (
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[10px] tabular-nums text-white/50">
                  {matchIds.length > 0
                    ? `${Math.min(activeMatch, matchIds.length - 1) + 1}/${matchIds.length}`
                    : "0/0"}
                </span>
              )}
              {/* Arrow-key navigation hint — only while matches exist. */}
              {matchIds.length > 0 && (
                <div className="pointer-events-none absolute left-0 top-full mt-1.5 flex items-center gap-2 rounded-md border border-white/10 bg-black/60 px-2 py-1 font-mono text-[10px] text-white/60 backdrop-blur">
                  <span className="flex items-center gap-0.5">
                    <ArrowUp className="h-3 w-3" />
                    <ArrowDown className="h-3 w-3" />
                    cycle
                  </span>
                  <span className="flex items-center gap-1">
                    <CornerDownLeft className="h-3 w-3" />
                    jump
                  </span>
                </div>
              )}
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

        {/* Breadcrumb trail — the "you are here" path for the current selection.
            Desktop overlay only; mobile gets context from the bottom-sheet header. */}
        {selected && trail.length > 1 && (
          <div className="pointer-events-auto absolute left-1/2 top-6 z-20 hidden -translate-x-1/2 md:block">
            <Breadcrumb className="rounded-lg border border-white/10 bg-black/50 px-3 py-1.5 backdrop-blur">
              <BreadcrumbList className="text-white/60">
                {trail.map((item, i) => {
                  const last = i === trail.length - 1;
                  return (
                    <Fragment key={item.id}>
                      <BreadcrumbItem>
                        {last ? (
                          <BreadcrumbPage className="max-w-[14rem] truncate text-white">
                            {item.label}
                          </BreadcrumbPage>
                        ) : (
                          <BreadcrumbLink asChild>
                            <button
                              type="button"
                              onClick={() => setSelectedId(item.id)}
                              className="max-w-[10rem] truncate text-white/60 transition-colors hover:text-white"
                            >
                              {item.label}
                            </button>
                          </BreadcrumbLink>
                        )}
                      </BreadcrumbItem>
                      {!last && <BreadcrumbSeparator className="text-white/30" />}
                    </Fragment>
                  );
                })}
              </BreadcrumbList>
            </Breadcrumb>
          </div>
        )}

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

        {/* Hover preview — a quick glance before committing to the full inspector */}
        {hovered && !selectedId && hovered.kind !== "core" && (
          <div
            ref={hoverCardRef}
            style={{ visibility: "hidden" }}
            className="pointer-events-none absolute left-0 top-0 z-20 w-[min(80vw,17rem)] rounded-lg border border-white/10 bg-black/85 p-2.5 shadow-xl shadow-black/50 backdrop-blur"
          >
            <div className="flex items-center gap-2">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{
                  background: rgbCss(hovered.color),
                  boxShadow: `0 0 6px ${rgba(hovered.color, 0.9)}`,
                }}
              />
              <span className="truncate text-sm font-semibold text-white">
                {hovered.label}
              </span>
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 pl-4.5">
              <span
                className="font-mono text-[10px] uppercase tracking-wide"
                style={{ color: rgba(hovered.color, 0.95) }}
              >
                {kindLabelFor(hovered.kind)}
              </span>
              {hovered.kind !== "topic" && (
                <FreshnessBadge info={nodeFreshness(hovered)} />
              )}
            </div>
            <p className="mt-1.5 line-clamp-3 text-xs leading-relaxed text-white/70">
              {describeNode(hovered)}
            </p>
            {hovered.kind === "topic" ? (
              <div className="mt-2 border-t border-white/10 pt-2">
                <ClusterMetricsRow
                  metrics={metricsByTopicId.get(hovered.id)}
                  tone="light"
                />
              </div>
            ) : (
              <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-white/10 pt-2 text-[10px] text-white/60">
                {hovered.meta.trade && (
                  <span className="max-w-[8rem] truncate">{hovered.meta.trade}</span>
                )}
                <span>
                  <b className="font-semibold tabular-nums text-white/85">
                    {model.degree[hovered.id] ?? 0}
                  </b>{" "}
                  conn
                </span>
                <span>
                  <b className="font-semibold tabular-nums text-white/85">
                    {inspectorVideoCount(hovered, model)}
                  </b>{" "}
                  vid
                </span>
                {hovered.meta.updatedAt && (
                  <span>Updated {timeAgo(hovered.meta.updatedAt)}</span>
                )}
              </div>
            )}
          </div>
        )}

        {/* Mobile-only scrim behind the bottom sheet. On desktop the graph stays
            FULLY visible — the floating inspector never dims or covers it. */}
        {selected && (
          <div className="pointer-events-none absolute inset-0 z-10 bg-black/40 md:hidden" />
        )}

        {/* Inspector — a standalone floating contextual card beside the node on
            desktop, a bottom sheet on mobile — so clicking any node ALWAYS shows
            its captured data without ever covering the graph edge-to-edge. */}
        {selected && detailProps && isDesktop && (
          <FloatingNodeInspector
            node={selected}
            degree={detailProps.degree}
            videoCount={detailProps.videoCount}
            pinned={pinnedIds.has(selected.id)}
            onTogglePin={() => togglePin(selected.id)}
            onClose={() => setSelectedId(null)}
            stageRef={stageRef}
            getScreenPos={(id) => canvasRef.current?.getScreenPos(id) ?? null}
          >
            <NodeDetailBody {...detailProps} />
          </FloatingNodeInspector>
        )}
        {selected && detailProps && !isDesktop && (
          <NodeInspectorPanel
            {...detailProps}
            onClose={() => setSelectedId(null)}
            pinned={pinnedIds.has(selected.id)}
            onTogglePin={() => togglePin(selected.id)}
          />
        )}
      </div>

      {/* Right rail — ambient panels only; per-node detail lives in the inspector */}
      <aside className="hidden w-80 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border bg-sidebar/85 p-4 backdrop-blur-md lg:flex">
        <LiveFeed
          recent={recent}
          colorByTrade={colorByTrade}
          onSelect={(id) => {
            // Prefer opening the node in-graph; fall back to the video page for
            // items not yet materialized as graph nodes (e.g. still processing).
            if (nodeById.has(`video:${id}`)) setSelectedId(`video:${id}`);
            else onOpenVideo(id);
          }}
        />
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

/**
 * "Videos" count for the inspector header: distinct source videos for a
 * knowledge concept, otherwise the related-video count for scaffold nodes.
 */
function inspectorVideoCount(
  node: MemoryNode | null,
  model: MemoryGraphData["model"],
): number {
  if (!node) return 0;
  if (isKnowledgeKind(node.kind)) {
    return node.meta.sourceCount ?? node.meta.sources?.length ?? 0;
  }
  return relatedVideoCount(node, model);
}

/** Human-readable summary for a node, reused by the hover card and inspector. */
function describeNode(node: MemoryNode): string {
  if (node.meta.description) return node.meta.description;
  switch (node.kind) {
    case "video":
      return node.status === "completed"
        ? "Transcribed and indexed into Jack's memory."
        : `Currently ${node.status ?? "queued"} — Jack is still learning from this.`;
    case "topic":
      return "A cluster of Jack's knowledge for this trade.";
    case "competency":
      return "A Red Seal competency mapped from Jack's videos.";
    case "mentor":
      return "An experienced tradesperson whose Interview Mode answers reinforce Jack's memory.";
    case "core":
      return "The core of Jack's living memory.";
    default:
      return "An atomic unit of knowledge distilled from Jack's videos.";
  }
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
  mentor_supplied: {
    label: "Mentor-supplied",
    color: [255, 205, 120],
    Icon: UserCheck,
  },
};

function formatTimestamp(sec: number): string {
  const t = Number.isFinite(sec) && sec > 0 ? sec : 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** A small colored pill communicating node health (Fresh / Needs Attention /
 *  Knowledge Gap), shared by the hover preview and the inspector header. */
function FreshnessBadge({ info }: { info: FreshnessInfo }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-1.5 py-[1px] text-[10px] font-semibold"
      style={{
        color: rgbCss(info.color),
        background: rgba(info.color, 0.14),
        border: `1px solid ${rgba(info.color, 0.4)}`,
      }}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ background: rgbCss(info.color) }}
      />
      {info.label}
    </span>
  );
}

const CLUSTER_METRIC_FIELDS: { key: keyof ClusterMetrics; label: string }[] = [
  { key: "knowledge", label: "Concepts" },
  { key: "videos", label: "Videos" },
  { key: "conversations", label: "Mentors" },
  { key: "procedures", label: "Procedures" },
  { key: "competencies", label: "Competencies" },
];

/** Compact composition line for a trade cluster (concept/video/mentor/… counts).
 *  `tone="light"` targets the dark hover card; the default targets the card UI. */
function ClusterMetricsRow({
  metrics,
  tone = "default",
}: {
  metrics?: ClusterMetrics;
  tone?: "default" | "light";
}) {
  if (!metrics) return null;
  const items = CLUSTER_METRIC_FIELDS.filter((f) => metrics[f.key] > 0);
  if (items.length === 0) return null;
  const valueClass = tone === "light" ? "text-white/85" : "text-foreground";
  const rowClass =
    tone === "light"
      ? "flex flex-wrap gap-x-2.5 gap-y-1 text-[10px] text-white/60"
      : "flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground";
  return (
    <div className={rowClass}>
      {items.map((f) => (
        <span key={f.key}>
          <b className={`font-semibold tabular-nums ${valueClass}`}>
            {metrics[f.key]}
          </b>{" "}
          {f.label}
        </span>
      ))}
    </div>
  );
}

interface NodeDetailProps {
  node: MemoryNode;
  degree: number;
  videoCount: number;
  relatedVideoCount: number;
  clusterMetrics?: ClusterMetrics;
  nodeById: Map<string, MemoryNode>;
  adjacency: Map<string, Set<string>>;
  knowledgeByVideoId: Map<string, MemoryNode[]>;
  compByCode: Map<string, string>;
  competencies: MemoryGraphData["competencies"];
  onOpenVideo: (id: string) => void;
  onJumpToTimestamp: (videoId: string, startTime: number) => void;
  onSelectNode: (id: string) => void;
  isAdmin: boolean;
  isUpdatingVerification: boolean;
  onSetVerification: (id: string, status: VerificationUpdateStatus) => void;
}

/**
 * Mobile / narrow-viewport node inspector — a bottom sheet. On desktop the
 * inspector is the standalone `FloatingNodeInspector` contextual card instead;
 * this component is only rendered below the desktop breakpoint, where a
 * full-width sheet anchored to the bottom is the appropriate pattern.
 */
function NodeInspectorPanel({
  onClose,
  pinned,
  onTogglePin,
  ...props
}: NodeDetailProps & {
  onClose: () => void;
  pinned: boolean;
  onTogglePin: () => void;
}) {
  const { node, degree, videoCount } = props;
  const knowledge = isKnowledgeKind(node.kind);
  const kLabel = kindLabelFor(node.kind);
  const freshness = node.kind === "core" ? null : nodeFreshness(node);
  const subtitle =
    node.kind === "core"
      ? kLabel
      : knowledge
        ? node.meta.trade
          ? `${kLabel} · ${node.meta.trade}`
          : kLabel
        : node.meta.trade ?? kLabel;

  const content = (
    <>
      <div className="flex items-start justify-between gap-2 border-b border-border/60 px-4 py-3">
        <div className="flex min-w-0 items-start gap-2.5">
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
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-xs" style={{ color: rgba(node.color, 0.95) }}>
                {subtitle}
              </span>
              {freshness && <FreshnessBadge info={freshness} />}
            </div>
            {/* High-level stats first — details live in collapsible sections. */}
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              <span>
                <b className="font-semibold tabular-nums text-foreground">
                  {degree}
                </b>{" "}
                Connection{degree === 1 ? "" : "s"}
              </span>
              <span aria-hidden className="text-white/20">
                ·
              </span>
              <span>
                <b className="font-semibold tabular-nums text-foreground">
                  {videoCount}
                </b>{" "}
                Video{videoCount === 1 ? "" : "s"}
              </span>
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {node.kind !== "core" && (
            <button
              onClick={onTogglePin}
              title={pinned ? "Unpin node" : "Pin node in place"}
              aria-label={pinned ? "Unpin node" : "Pin node in place"}
              className={`-mt-1 flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
                pinned
                  ? "bg-primary/20 text-primary"
                  : "text-muted-foreground hover:bg-white/10 hover:text-foreground"
              }`}
            >
              {pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
            </button>
          )}
          <button
            onClick={onClose}
            title="Close"
            aria-label="Close"
            className="-mr-1 -mt-1 flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      {/* Keyed by node id: switching nodes resets scroll + collapsibles to the
          high-level view WITHOUT remounting (and re-animating) the panel shell. */}
      <div
        key={node.id}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3"
      >
        <NodeDetailBody {...props} />
      </div>
    </>
  );

  // A bottom sheet — full width is acceptable on narrow / mobile screens.
  return (
    <div
      role="dialog"
      aria-label={`${node.label} details`}
      className="pointer-events-auto absolute inset-x-2 bottom-2 z-30 flex max-h-[80dvh] flex-col overflow-hidden rounded-2xl border border-white/10 bg-card/95 shadow-2xl shadow-black/60 ring-1 ring-white/5 backdrop-blur-xl duration-200 ease-out animate-in fade-in-0 slide-in-from-bottom-4"
    >
      {content}
    </div>
  );
}

/**
 * Independently-collapsible inspector section. Default collapsed so the panel
 * opens on high-level info only — the user expands what they care about.
 */
function Section({
  title,
  count,
  defaultOpen = false,
  children,
}: {
  title: string;
  count?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-t border-border/50 first:border-t-0">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 py-2.5 text-left"
      >
        <ChevronRight
          className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${
            open ? "rotate-90" : ""
          }`}
        />
        <span className="flex-1 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          {title}
        </span>
        {count != null && count > 0 && (
          <span className="rounded-full bg-white/5 px-1.5 font-mono text-[10px] tabular-nums text-muted-foreground/80">
            {count}
          </span>
        )}
      </button>
      {open && <div className="pb-3">{children}</div>}
    </div>
  );
}

/**
 * Video analysis + key points Jack distilled. Fetched lazily — only mounts (and
 * fetches) when the "Captured Knowledge" section is expanded.
 */
function AnalysisContent({ node }: { node: MemoryNode }) {
  const videoId = node.kind === "video" ? node.id.replace("video:", "") : "";
  const enabled = videoId.length > 0;
  const { data: video, isLoading } = useGetVideo(videoId, {
    query: { enabled, queryKey: getGetVideoQueryKey(videoId) },
  });

  if (!enabled) return null;
  if (isLoading) {
    return <p className="text-xs text-muted-foreground">Reading Jack's capture…</p>;
  }

  const hasContent =
    Boolean(video?.analysis) || (video?.keyPoints?.length ?? 0) > 0;
  if (!hasContent) {
    return (
      <p className="text-xs text-muted-foreground">
        No analysis captured yet — this source is still processing.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {video?.analysis && (
        <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground/90">
          {video.analysis}
        </p>
      )}
      {video?.keyPoints && video.keyPoints.length > 0 && (
        <div>
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            Key Points
          </div>
          <ul className="list-disc space-y-1 pl-4 text-xs text-foreground/80">
            {video.keyPoints.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * The verbatim transcript Jack captured: the full transcript for a video, or the
 * transcript line at each cited moment for a concept — fetched live from the
 * source video. Lazily mounted with the "Transcript" section; every timestamp
 * jumps straight to that moment in the player.
 */
function TranscriptContent({
  node,
  onJumpToTimestamp,
}: {
  node: MemoryNode;
  onJumpToTimestamp: (videoId: string, startTime: number) => void;
}) {
  const knowledge = isKnowledgeKind(node.kind);
  const isVideo = node.kind === "video";

  // Which source video holds the verbatim capture, and which moments matter.
  let videoId = "";
  let stamps: number[] = [];
  if (isVideo) {
    videoId = node.id.replace("video:", "");
  } else if (knowledge) {
    const sources = [...(node.meta.sources ?? [])].sort(
      (a, b) =>
        b.timestamps.length - a.timestamps.length || b.confidence - a.confidence,
    );
    videoId = sources[0]?.videoId ?? "";
    stamps = sources[0]?.timestamps ?? [];
  }

  const enabled = videoId.length > 0;
  const { data: video, isLoading } = useGetVideo(videoId, {
    query: { enabled, queryKey: getGetVideoQueryKey(videoId) },
  });

  if (!enabled) return null;

  const segments = video?.segments ?? [];

  // For a concept, pull the transcript line at each cited moment — verbatim,
  // exactly what Jack captured. Capped generously so nothing meaningful is lost.
  const passages: { key: string; time: number; text: string }[] = [];
  if (knowledge && stamps.length > 0 && segments.length > 0) {
    const seen = new Set<string>();
    for (const t of stamps) {
      if (passages.length >= 24) break;
      let best = segments[0];
      let bestScore = Infinity;
      for (const s of segments) {
        const within = t >= s.startTime && t <= s.endTime;
        const score = within ? -1 : Math.abs(s.startTime - t);
        if (score < bestScore) {
          bestScore = score;
          best = s;
        }
      }
      const key = String(best.id ?? best.startTime);
      if (seen.has(key) || !best.text?.trim()) continue;
      seen.add(key);
      passages.push({ key, time: best.startTime, text: best.text.trim() });
    }
  }

  if (isLoading) {
    return <p className="text-xs text-muted-foreground">Reading Jack's capture…</p>;
  }

  const hasContent = (isVideo && segments.length > 0) || passages.length > 0;
  if (!hasContent) {
    return (
      <p className="text-xs text-muted-foreground">
        No transcript captured yet — this source is still processing.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {isVideo && segments.length > 0 && (
        <div className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
          {segments.map((s, i) => (
            <div key={s.id ?? i} className="flex gap-2 text-xs leading-relaxed">
              <button
                onClick={() => onJumpToTimestamp(videoId, s.startTime)}
                className="mt-px inline-flex h-fit shrink-0 items-center gap-1 rounded bg-primary/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-primary transition-colors hover:bg-primary/25"
              >
                <Play className="h-2.5 w-2.5" />
                {formatTimestamp(s.startTime)}
              </button>
              <span className="text-foreground/85">{s.text}</span>
            </div>
          ))}
        </div>
      )}
      {passages.length > 0 && (
        <div className="space-y-2">
          {video?.title && (
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
              Cited in {video.title}
            </div>
          )}
          {passages.map((p) => (
            <blockquote
              key={p.key}
              className="border-l-2 border-primary/50 pl-2.5 text-xs leading-relaxed text-foreground/85"
            >
              <button
                onClick={() => onJumpToTimestamp(videoId, p.time)}
                className="mb-0.5 inline-flex items-center gap-1 rounded-md bg-primary/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-primary transition-colors hover:bg-primary/25"
              >
                <Play className="h-2.5 w-2.5" />
                {formatTimestamp(p.time)}
              </button>
              <span className="block">&ldquo;{p.text}&rdquo;</span>
            </blockquote>
          ))}
        </div>
      )}
    </div>
  );
}

function NodeDetailBody({
  node,
  degree,
  relatedVideoCount,
  clusterMetrics,
  nodeById,
  adjacency,
  knowledgeByVideoId,
  compByCode,
  competencies,
  onOpenVideo,
  onJumpToTimestamp,
  onSelectNode,
  isAdmin,
  isUpdatingVerification,
  onSetVerification,
}: NodeDetailProps) {
  const knowledge = isKnowledgeKind(node.kind);

  const description = describeNode(node);

  const confidence =
    typeof node.meta.confidence === "number"
      ? Math.max(0, Math.min(1, node.meta.confidence))
      : undefined;

  const verifyKey = (node.meta.verificationStatus ?? "").toLowerCase();
  const verify = VERIFICATION_META[verifyKey];

  const sources: NodeSource[] = knowledge ? node.meta.sources ?? [] : [];
  const aliases = knowledge ? node.meta.aliases ?? [] : [];

  // The originating source: a concept's most-cited video, or the video itself.
  const primarySource = knowledge
    ? [...sources].sort(
        (a, b) =>
          b.timestamps.length - a.timestamps.length ||
          b.confidence - a.confidence,
      )[0]
    : undefined;

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

  // Competencies + mentors directly linked to a knowledge node (via edges).
  const linkedComps: { code: string; name: string }[] = [];
  const linkedMentors: MemoryNode[] = [];
  if (knowledge) {
    for (const id of adjacency.get(node.id) ?? []) {
      if (id.startsWith("comp:")) {
        const code = nodeById.get(id)?.meta.code ?? id.replace("comp:", "");
        linkedComps.push({ code, name: compByCode.get(code) ?? "" });
      } else if (id.startsWith("mentor:")) {
        const mn = nodeById.get(id);
        if (mn) linkedMentors.push(mn);
      }
    }
  }
  const mentorSupplied =
    knowledge &&
    (verifyKey === "mentor_supplied" || linkedMentors.length > 0);

  const isVideo = node.kind === "video";
  // Which collapsible sections are worth offering for this node.
  const relComp = knowledge ? null : relatedCompetencyList(node, competencies);
  const showCompetencies = knowledge
    ? linkedComps.length > 0
    : (relComp?.list.length ?? 0) > 0;
  const hasCaptured =
    isVideo || (knowledge && (confidence !== undefined || aliases.length > 0));
  const hasTranscript = isVideo || (knowledge && sources.length > 0);
  // Union of the individual Metadata row conditions — avoids an empty box on
  // scaffold nodes (topic/core) that have none of the detail rows.
  const hasMetadata =
    knowledge ||
    node.kind === "video" ||
    node.kind === "competency" ||
    Boolean(node.meta.updatedAt);

  return (
    <>
      {/* Cluster rollup for trade hubs — the size + composition of the knowledge
          orbiting this trade at a glance. Shared by the desktop floating card and
          the mobile bottom sheet, so it renders once here rather than per-shell. */}
      {node.kind === "topic" && clusterMetrics && (
        <div className="mb-3 border-b border-border/60 pb-3">
          <ClusterMetricsRow metrics={clusterMetrics} />
        </div>
      )}
      {description && (
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
          {description}
        </p>
      )}

      {/* Primary action — one click to the originating moment/video. This row is
          the home for future per-node actions, so it always reserves its slot. */}
      {isVideo && (
        <button
          onClick={() => onOpenVideo(node.id.replace("video:", ""))}
          className="mb-3 flex w-full items-center justify-center gap-1.5 rounded-lg bg-primary/15 py-2 text-xs font-semibold text-primary transition-colors hover:bg-primary/25"
        >
          <ExternalLink className="h-3.5 w-3.5" /> View Original Source
        </button>
      )}
      {knowledge && primarySource && (
        <button
          onClick={() =>
            onJumpToTimestamp(
              primarySource.videoId,
              primarySource.timestamps[0] ?? 0,
            )
          }
          className="mb-3 flex w-full items-center justify-center gap-1.5 rounded-lg bg-primary/15 py-2 text-xs font-semibold text-primary transition-colors hover:bg-primary/25"
        >
          <ExternalLink className="h-3.5 w-3.5" /> View Original Source
        </button>
      )}

      {mentorSupplied && (
        <div className="mb-3 rounded-lg border border-amber-400/30 bg-amber-400/10 p-2.5">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-300">
            <UserCheck className="h-3.5 w-3.5" /> Mentor-supplied knowledge
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-amber-200/80">
            {linkedMentors.length > 0
              ? `Corroborated by ${linkedMentors
                  .map((m) => m.label)
                  .join(", ")} during Interview Mode.`
              : "Contributed by an experienced tradesperson during Interview Mode."}
          </p>
        </div>
      )}

      {/* Everything below is independently collapsible; sections open on demand
          so the panel leads with the high-level view (name + header stats). */}
      <div className="-mx-1 px-1">
        {showCompetencies && (
          <Section
            title="Competencies"
            count={knowledge ? linkedComps.length : relComp?.list.length}
          >
            {knowledge ? (
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
            ) : (
              relComp && (
                <RelatedCompetencies
                  node={node}
                  list={relComp.list}
                  mapped={relComp.mapped}
                  onSelectNode={onSelectNode}
                />
              )
            )}
          </Section>
        )}

        {related.length > 0 && (
          <Section title="Related Nodes" count={related.length}>
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
          </Section>
        )}

        {hasCaptured && (
          <Section title="Captured Knowledge">
            <div className="space-y-3">
              {isVideo && <AnalysisContent node={node} />}
              {knowledge && confidence !== undefined && (
                <div>
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
              {knowledge && aliases.length > 0 && (
                <div>
                  <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                    Also called
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {aliases.map((a) => (
                      <span
                        key={a}
                        className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
                      >
                        {a}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </Section>
        )}

        {hasTranscript && (
          <Section title="Transcript">
            <TranscriptContent node={node} onJumpToTimestamp={onJumpToTimestamp} />
          </Section>
        )}

        {knowledge && sources.length > 0 && (
          <Section title="Source Videos" count={sources.length}>
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
          </Section>
        )}

        {hasMetadata && (
        <Section title="Metadata">
          <div className="divide-y divide-border/60 rounded-lg border border-border/60">
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
            {node.kind === "video" && node.status && (
              <Row label="Status" value={node.status} />
            )}
            {knowledge && sources.length > 0 && (
              <Row label="Sources" value={node.meta.sourceCount ?? sources.length} />
            )}
            {(node.kind === "video" || node.kind === "competency") && (
              <Row label="Related Videos" value={relatedVideoCount} />
            )}
            {node.meta.updatedAt && (
              <Row label="Last Updated" value={timeAgo(node.meta.updatedAt)} />
            )}
            {node.kind === "competency" && node.meta.code && (
              <Row label="Code" value={node.meta.code} />
            )}
          </div>
        </Section>
        )}

        {knowledge && isAdmin && (
          <Section title="Review" defaultOpen>
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
          </Section>
        )}
      </div>
    </>
  );
}

type Competency = MemoryGraphData["competencies"][number];

/**
 * The competencies most relevant to a scaffold node (topic/video), mapped-first.
 * Returned separately so the inspector can both size the section header (count)
 * and render the list without duplicating the ranking logic.
 */
function relatedCompetencyList(
  node: MemoryNode | null,
  competencies: MemoryGraphData["competencies"],
): { list: Competency[]; mapped: Set<string> } {
  const trade = node?.meta.trade;
  const mapped = new Set(node?.meta.competencyCodes ?? []);

  let list = trade
    ? competencies.filter((c) => c.trade === trade)
    : [...competencies].sort((a, b) => (b.videoCount ?? 0) - (a.videoCount ?? 0));

  // Surface the ones this node actually maps to first.
  list = [...list].sort(
    (a, b) => Number(mapped.has(b.code)) - Number(mapped.has(a.code)),
  );
  return { list: list.slice(0, 6), mapped };
}

function RelatedCompetencies({
  node,
  list,
  mapped,
  onSelectNode,
}: {
  node: MemoryNode | null;
  list: Competency[];
  mapped: Set<string>;
  onSelectNode: (id: string) => void;
}) {
  void node;
  if (list.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">No competencies linked yet.</p>
    );
  }
  return (
    <ul className="space-y-2">
      {list.map((c) => (
        <li key={c.code} className="flex items-center justify-between gap-2">
          <button
            onClick={() => onSelectNode(`comp:${c.code}`)}
            className="min-w-0 flex-1 text-left"
            title={c.name}
          >
            <span className="block truncate text-sm font-medium text-foreground transition-colors hover:text-primary">
              {c.code} · {c.name}
            </span>
          </button>
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
  );
}
