import { useMemo } from "react";
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
  buildGraphModel,
  buildGraphModelFromServer,
  readUpdatedAt,
  type GraphModel,
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

  const model = useMemo(() => {
    if (graph && graph.nodes.length > 0) {
      return buildGraphModelFromServer({ nodes: graph.nodes, edges: graph.edges });
    }
    // Fallback: derive the graph client-side if the persisted graph is empty or
    // unavailable (e.g. schema not yet applied) so the view is never blank.
    return buildGraphModel(videos, competencies);
    // Rebuild when the underlying query payloads change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, videoList, competencyList]);

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
  };
}
