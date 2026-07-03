import { useMemo, useRef } from "react";
import {
  useListVideos,
  useListCompetencies,
  useGetRecentVideos,
  useGetGraph,
  getListVideosQueryKey,
  getGetRecentVideosQueryKey,
  getGetGraphQueryKey,
} from "@workspace/api-client-react";
import {
  computeGraphDelta,
  computeVitality,
  readUpdatedAt,
  selectMemoryGraphModel,
  EMPTY_DELTA,
  type GraphDelta,
  type GraphModel,
  type MemoryVitality,
  type RawCompetency,
  type RawVideo,
} from "./memory-graph";
import { IN_FLIGHT_STATUSES } from "./video-status";

export interface MemoryGraphData {
  model: GraphModel;
  videos: RawVideo[];
  competencies: RawCompetency[];
  recent: RawVideo[];
  readyCount: number;
  lastUpdated?: string;
  isLoading: boolean;
  /** Whole-graph vitality read-out for the ambient health indicator. */
  vitality: MemoryVitality;
  /** What changed since the previous /graph snapshot (births, strengthening). */
  delta: GraphDelta;
  /** Server snapshot timestamp; the delta only re-fires when this changes. */
  generatedAt?: string;
}

/**
 * Centralized live data feed for the Memory Graph. The graph itself is the
 * server-persisted "Living Memory" (GET /graph) — nodes/edges written by the
 * backend as videos are processed. We still poll /videos & /competencies for the
 * surrounding stats (ready count, last-updated) and processing-aware polling, and
 * fall back to deriving the graph client-side if the server graph is unavailable.
 */
export function useMemoryGraphData(): MemoryGraphData {
  const { data: videoList, isLoading } = useListVideos(
    { limit: 200 },
    {
      query: {
        queryKey: getListVideosQueryKey({ limit: 200 }),
        refetchInterval: (q) => {
          const vids =
            (q.state.data as { videos?: RawVideo[] } | undefined)?.videos ?? [];
          const processing = vids.some((v) => IN_FLIGHT_STATUSES.has(v.status ?? ""));
          return processing ? 4000 : 8000;
        },
      },
    },
  );
  const { data: competencyList } = useListCompetencies();
  const { data: recentList } = useGetRecentVideos({
    query: { queryKey: getGetRecentVideosQueryKey(), refetchInterval: 8000 },
  });

  const videos = (videoList?.videos ?? []) as unknown as RawVideo[];
  const competencies = (competencyList ?? []) as unknown as RawCompetency[];
  const recent = (recentList ?? []) as unknown as RawVideo[];

  // Poll the graph faster while anything is still processing so newly ingested
  // memories visibly appear (and pick up competency edges) as Jack finishes.
  const processing = videos.some((v) => IN_FLIGHT_STATUSES.has(v.status ?? ""));
  const { data: graph } = useGetGraph({
    query: {
      queryKey: getGetGraphQueryKey(),
      refetchInterval: processing ? 4000 : 8000,
    },
  });

  const model = useMemo(
    () => selectMemoryGraphModel(graph, videos, competencies),
    // Rebuild when the underlying query payloads change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph, videoList, competencyList],
  );

  const generatedAt = (graph as { generatedAt?: string } | undefined)
    ?.generatedAt;

  const vitality = useMemo(() => computeVitality(model), [model]);

  // Diff the current snapshot against the previous one. Keyed on the model +
  // server timestamp so it only re-fires on a real data change (never on
  // re-render or canvas re-simulation). First load yields an empty delta.
  const prevModelRef = useRef<GraphModel | null>(null);
  const seqRef = useRef(0);
  const delta = useMemo(() => {
    const prev = prevModelRef.current;
    const d = computeGraphDelta(prev, model, seqRef.current + 1, generatedAt);
    // Only advance the shared sequence when something actually changed, so
    // toast/animation effects can dedupe on `delta.seq`.
    if (d.seq > seqRef.current) seqRef.current = d.seq;
    prevModelRef.current = model;
    return d;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, generatedAt]);

  const readyCount = videos.filter((v) => v.status === "completed").length;

  const lastUpdated = useMemo(() => {
    let best = 0;
    let iso: string | undefined;
    for (const v of videos) {
      const u = readUpdatedAt(v);
      if (!u) continue;
      const t = new Date(u).getTime();
      if (!Number.isNaN(t) && t > best) {
        best = t;
        iso = u;
      }
    }
    return iso;
  }, [videos]);

  return {
    model,
    videos,
    competencies,
    recent,
    readyCount,
    lastUpdated,
    isLoading,
    vitality,
    delta,
    generatedAt,
  };
}
