import { useMemo, useState } from "react";
import { isKnowledgeKind } from "../lib/memory-graph";
import type { MemoryGraphData } from "../lib/use-memory-graph";

interface Props {
  data: MemoryGraphData;
  onJumpToTimestamp: (videoId: string, seconds: number) => void;
  onOpenGraph: (nodeId: string) => void;
}

export function InsightsView({ data, onJumpToTimestamp, onOpenGraph }: Props) {
  const [trade, setTrade] = useState("all");
  const videos = useMemo(
    () =>
      new Map(
        data.model.nodes
          .filter(
            (node) => node.kind === "video" && node.status === "completed",
          )
          .map((node) => [node.id.slice("video:".length), node]),
      ),
    [data.model.nodes],
  );
  const insights = useMemo(() => {
    const mentorIds = new Set(
      data.model.nodes
        .filter((node) => node.kind === "mentor")
        .map((node) => node.id),
    );
    const mentorCountByNode = new Map<string, number>();
    for (const edge of data.model.edges) {
      const knowledgeId = mentorIds.has(edge.a)
        ? edge.b
        : mentorIds.has(edge.b)
          ? edge.a
          : null;
      if (knowledgeId)
        mentorCountByNode.set(
          knowledgeId,
          (mentorCountByNode.get(knowledgeId) ?? 0) + 1,
        );
    }
    return data.model.nodes
      .flatMap((node) => {
        if (
          !isKnowledgeKind(node.kind) ||
          node.meta.verificationStatus === "rejected"
        )
          return [];
        const sources = (node.meta.sources ?? []).filter((source) =>
          videos.has(source.videoId),
        );
        const mentorSources = mentorCountByNode.get(node.id) ?? 0;
        if (!sources.length && !mentorSources) return [];
        return [{ node, sources, mentorSources }];
      })
      .sort(
        (a, b) =>
          (b.node.meta.sourceCount ?? b.sources.length + b.mentorSources) -
          (a.node.meta.sourceCount ?? a.sources.length + a.mentorSources),
      );
  }, [data.model.nodes, data.model.edges, videos]);
  const trades = [
    ...new Set(
      insights
        .map(({ node }) => node.meta.trade)
        .filter((value): value is string => !!value),
    ),
  ].sort();
  const visible =
    trade === "all"
      ? insights
      : insights.filter(({ node }) => node.meta.trade === trade);

  return (
    <section
      className="h-full w-full overflow-y-auto p-4 md:p-6"
      aria-label="Insights"
    >
      <div className="mx-auto max-w-5xl space-y-5">
        <header>
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-primary">
            What Jack is learning
          </p>
          <h1 className="mt-1 text-2xl font-black md:text-3xl">Insights</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Evidence-backed findings in Living Memory. Open a source to check
            what supports each finding.
          </p>
        </header>
        <label className="flex items-center gap-3 text-sm">
          Trade
          <select
            value={trade}
            onChange={(event) => setTrade(event.target.value)}
            className="rounded-lg border border-border bg-card px-3 py-2"
          >
            <option value="all">All trades</option>
            {trades.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        {data.isLoading ? (
          <p role="status">Loading insights…</p>
        ) : data.graphError ? (
          <p role="alert">Insights could not be loaded. Try again shortly.</p>
        ) : data.hasError && !insights.length ? (
          <p role="alert">Insights could not be loaded. Try again shortly.</p>
        ) : !visible.length ? (
          <p className="rounded-xl border border-border bg-card/70 p-5 text-sm text-muted-foreground">
            No sourced findings are available for this selection yet.
          </p>
        ) : (
          <div className="space-y-3">
            {visible.map(({ node, sources, mentorSources }) => (
              <article
                key={node.id}
                className="rounded-xl border border-border bg-card/70 p-4 md:p-5"
              >
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span className="capitalize text-primary">
                    {node.kind.replaceAll("_", " ")}
                  </span>
                  {node.meta.trade && <span>· {node.meta.trade}</span>}
                  {sources.length > 0 && (
                    <span>
                      · {sources.length} linked video{" "}
                      {sources.length === 1 ? "source" : "sources"}
                    </span>
                  )}
                  {mentorSources > 0 && (
                    <span>
                      · {mentorSources} interview{" "}
                      {mentorSources === 1 ? "contribution" : "contributions"}
                    </span>
                  )}
                  {node.meta.verificationStatus === "verified" && (
                    <span>· Human reviewed</span>
                  )}
                  {node.meta.verificationStatus !== "verified" && (
                    <span>· Not human reviewed</span>
                  )}
                </div>
                <h2 className="mt-2 text-lg font-semibold">{node.label}</h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  {sources.length + mentorSources > 1
                    ? "Why it matters: more than one source contributes to this finding. Compare the evidence before using it."
                    : "Why it matters: this is traceable to one source. Check the evidence before applying it in the field."}
                </p>
                <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Evidence
                </p>
                {mentorSources > 0 && (
                  <p className="mt-2 text-sm text-muted-foreground">
                    Interview contribution recorded in Living Memory. Open
                    provenance to review its context.
                  </p>
                )}
                <ul className="mt-2 flex flex-wrap gap-2">
                  {sources.map((source) => {
                    const video = videos.get(source.videoId);
                    return (
                      <li key={source.videoId}>
                        <button
                          type="button"
                          onClick={() =>
                            onJumpToTimestamp(
                              source.videoId,
                              source.timestamps[0] ?? 0,
                            )
                          }
                          className="rounded-lg border border-border px-3 py-2 text-left text-sm hover:border-primary"
                        >
                          {video?.label || "Source video"}
                          {source.timestamps.length
                            ? ` · ${Math.floor(source.timestamps[0] / 60)}:${String(Math.floor(source.timestamps[0] % 60)).padStart(2, "0")}`
                            : ""}
                        </button>
                      </li>
                    );
                  })}
                </ul>
                <button
                  type="button"
                  onClick={() => onOpenGraph(node.id)}
                  className="mt-3 text-sm font-semibold text-primary underline"
                >
                  Open provenance in Living Memory
                </button>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
