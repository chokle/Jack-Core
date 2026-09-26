import { useMemo, useState } from "react";
import type { MemoryGraphData } from "../lib/use-memory-graph";
import { isKnowledgeKind } from "../lib/memory-graph";

interface Props {
  data: MemoryGraphData;
  onOpenVideo: (id: string) => void;
  onOpenGraph: (nodeId: string) => void;
}

export function CompetenciesView({ data, onOpenVideo, onOpenGraph }: Props) {
  const [query, setQuery] = useState("");
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const competencies = useMemo(
    () =>
      data.competencies.filter((item) =>
        `${item.code} ${item.name} ${item.trade}`
          .toLowerCase()
          .includes(query.toLowerCase().trim()),
      ),
    [data.competencies, query],
  );
  const selected = data.competencies.find((item) => item.code === selectedCode);
  const linkedIds = new Set(
    selected
      ? data.model.edges
          .filter(
            (edge) =>
              edge.a === `comp:${selected.code}` ||
              edge.b === `comp:${selected.code}`,
          )
          .map((edge) => (edge.a === `comp:${selected.code}` ? edge.b : edge.a))
      : [],
  );
  const knowledge = data.model.nodes.filter(
    (node) =>
      isKnowledgeKind(node.kind) &&
      node.meta.verificationStatus !== "rejected" &&
      linkedIds.has(node.id),
  );
  const videos = data.model.nodes.filter(
    (node) =>
      node.kind === "video" &&
      node.status === "completed" &&
      linkedIds.has(node.id),
  );

  return (
    <section
      className="h-full w-full overflow-y-auto p-4 md:p-6"
      aria-label="Competencies"
    >
      <div className="mx-auto max-w-6xl space-y-5">
        <header>
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-primary">
            Trade knowledge
          </p>
          <h1 className="mt-1 text-2xl font-black md:text-3xl">Competencies</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Browse Red Seal competencies and the knowledge Jack has linked to
            them. These are knowledge links, not a rating of any worker.
          </p>
        </header>
        <label className="block text-sm">
          <span className="sr-only">Search competencies</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search trade, code, or competency"
            className="w-full rounded-xl border border-border bg-card px-4 py-3 text-foreground outline-none focus:border-primary"
          />
        </label>
        {data.isLoading ? (
          <p role="status">Loading competencies…</p>
        ) : data.hasError && !data.competencies.length ? (
          <p role="alert">
            Competencies could not be loaded. Try again shortly.
          </p>
        ) : !data.competencies.length ? (
          <p>No competencies are available yet.</p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
            <div className="max-h-[65vh] space-y-2 overflow-y-auto rounded-xl border border-border bg-card/60 p-3">
              {competencies.length ? (
                competencies.map((item) => (
                  <button
                    key={item.code}
                    type="button"
                    onClick={() => setSelectedCode(item.code)}
                    aria-pressed={selectedCode === item.code}
                    className={`w-full rounded-lg border p-3 text-left transition-colors ${selectedCode === item.code ? "border-primary bg-primary/10" : "border-border hover:bg-muted/60"}`}
                  >
                    <span className="block text-xs text-primary">
                      {item.trade} · {item.code}
                    </span>
                    <span className="mt-1 block font-semibold">
                      {item.name}
                    </span>
                  </button>
                ))
              ) : (
                <p className="p-3 text-sm text-muted-foreground">
                  No matching competencies.
                </p>
              )}
            </div>
            <div className="rounded-xl border border-border bg-card/70 p-4">
              {selected && data.graphError ? (
                <p role="alert">
                  Living Memory links could not be loaded. Try again shortly.
                </p>
              ) : selected ? (
                <div className="space-y-5">
                  <div>
                    <p className="text-xs text-primary">
                      {selected.trade} · {selected.code}
                    </p>
                    <h2 className="mt-1 text-xl font-bold">{selected.name}</h2>
                    {selected.description && (
                      <p className="mt-2 text-sm text-muted-foreground">
                        {selected.description}
                      </p>
                    )}
                  </div>
                  <div>
                    <h3 className="font-semibold">
                      Linked Living Memory ({knowledge.length})
                    </h3>
                    {knowledge.length ? (
                      <ul className="mt-2 space-y-2 text-sm">
                        {knowledge.map((node) => (
                          <li
                            key={node.id}
                            className="rounded-lg border border-border p-3"
                          >
                            <span className="text-xs capitalize text-muted-foreground">
                              {node.kind.replaceAll("_", " ")}
                            </span>
                            <span className="mt-1 block">{node.label}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-2 text-sm text-muted-foreground">
                        No Living Memory knowledge is linked yet.
                      </p>
                    )}
                    <button
                      type="button"
                      onClick={() => onOpenGraph(`comp:${selected.code}`)}
                      className="mt-2 text-sm font-semibold text-primary underline"
                    >
                      Open Living Memory
                    </button>
                  </div>
                  <div>
                    <h3 className="font-semibold">
                      Linked videos ({videos.length})
                    </h3>
                    {videos.length ? (
                      <ul className="mt-2 space-y-2">
                        {videos.map((video) => (
                          <li key={video.id}>
                            <button
                              type="button"
                              onClick={() =>
                                onOpenVideo(video.id.slice("video:".length))
                              }
                              className="w-full rounded-lg border border-border p-3 text-left text-sm hover:border-primary"
                            >
                              {video.label || "Untitled video"}
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-2 text-sm text-muted-foreground">
                        No processed videos linked yet.
                      </p>
                    )}
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Choose a competency to see Jack’s linked evidence.
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
