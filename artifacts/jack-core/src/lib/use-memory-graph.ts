import { useMemo } from "react";
import {
  useListVideos,
  useListCompetencies,
  useGetRecentVideos,
  getListVideosQueryKey,
  getGetRecentVideosQueryKey,
} from "@workspace/api-client-react";
import {
  buildGraphModel,
  readUpdatedAt,
  type GraphModel,
  type RawCompetency,
  type RawVideo,
} from "./memory-graph";

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
 * Centralized live data feed for the Memory Graph. Polls faster while anything
 * is still processing so the graph visibly grows as Jack ingests new memories.
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
          const processing = vids.some(
            (v) =>
              v.status === "pending" ||
              v.status === "transcribing" ||
              v.status === "analyzing",
          );
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

  const model = useMemo(
    () => buildGraphModel(videos, competencies),
    // Rebuild when the underlying query payloads change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [videoList, competencyList],
  );

  const readyCount = videos.filter((v) => v.status === "ready").length;

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
