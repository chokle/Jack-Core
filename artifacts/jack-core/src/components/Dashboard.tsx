import type { GraphModel } from "../lib/memory-graph";
import { SiteHudLive } from "./SiteHudLive";
import { SiteMappingHub } from "./SiteMappingHub";

interface DashboardProps {
  model: GraphModel;
  readyCount: number;
  lastUpdatedLabel: string;
  knowledgeState?: "loading" | "error" | "ready";
  siteHudUserId?: string;
  onOpenCompetencies?: () => void;
  onOpenInsights?: () => void;
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card/70 p-5 backdrop-blur-sm">
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-2 text-3xl font-black tracking-tight text-foreground">
        {value}
      </div>
    </div>
  );
}

export function Dashboard({
  model,
  readyCount,
  lastUpdatedLabel,
  knowledgeState = "ready",
  siteHudUserId,
  onOpenCompetencies,
  onOpenInsights,
}: DashboardProps) {
  const nodes = model.counts.nodes.toLocaleString("en-US");
  const connections = model.counts.connections.toLocaleString("en-US");
  const knowledge = model.counts.knowledge.toLocaleString("en-US");
  const topics = model.counts.topics.toLocaleString("en-US");

  return (
    <section
      className="h-full w-full overflow-y-auto p-4 md:p-6"
      aria-label="Jack dashboard"
    >
      <div className="mx-auto max-w-6xl space-y-6">
        <header>
          <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-primary">
            Jack Intelligence
          </div>
          <h1 className="mt-1 text-2xl font-black tracking-tight md:text-3xl">
            Dashboard
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Jack&apos;s primary site workspace: live field awareness, private
            measured geometry, and the knowledge connected to the work.
          </p>
        </header>

        <div
          className="rounded-2xl border border-border bg-card/70 p-5"
          data-tour-target="radar"
        >
          <h2 className="text-lg font-bold">Site spatial state</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Live field awareness and private measured depth share one spatial
            state. Local AR coordinates are not surveyed or aligned.
          </p>
          {siteHudUserId ? (
            <SiteHudLive expanded onOpenRadar={() => undefined} />
          ) : (
            <SiteMappingHub />
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={onOpenCompetencies}
            disabled={!onOpenCompetencies}
            className="rounded-2xl border border-border bg-card/70 p-5 text-left transition-colors enabled:hover:bg-muted/60 disabled:cursor-default"
          >
            <span className="text-base font-bold">Competencies</span>
            <span className="mt-1 block text-sm text-muted-foreground">
              Open trade competencies connected to Living Memory evidence.
            </span>
          </button>
          <button
            type="button"
            onClick={onOpenInsights}
            disabled={!onOpenInsights}
            className="rounded-2xl border border-border bg-card/70 p-5 text-left transition-colors enabled:hover:bg-muted/60 disabled:cursor-default"
          >
            <span className="text-base font-bold">Insights</span>
            <span className="mt-1 block text-sm text-muted-foreground">
              Open evidence-backed findings connected to the current memory.
            </span>
          </button>
        </div>

        {knowledgeState === "loading" ? (
          <p role="status">Loading dashboard knowledge…</p>
        ) : knowledgeState === "error" ? (
          <p role="alert">
            Dashboard knowledge data could not be loaded. Site scans can still
            be viewed.
          </p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              <StatCard label="Memory nodes" value={nodes} />
              <StatCard label="Connections" value={connections} />
              <StatCard label="Concepts" value={knowledge} />
              <StatCard label="Trade topics" value={topics} />
              <StatCard
                label="Videos processed"
                value={readyCount.toLocaleString("en-US")}
              />
            </div>

            <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
              <div className="rounded-2xl border border-border bg-card/70 p-5">
                <h2 className="text-lg font-bold">Trade knowledge</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Knowledge and processed video counts by trade. These counts do
                  not measure worker competency or site safety.
                </p>
                {model.topics.length ? (
                  <ul className="mt-4 space-y-3">
                    {model.topics.map((topic) => (
                      <li
                        key={topic.id}
                        className="flex items-center justify-between gap-3 border-b border-border pb-2 text-sm"
                      >
                        <span className="font-medium">{topic.label}</span>
                        <span className="font-mono text-muted-foreground">
                          {topic.metrics.knowledge} concepts ·{" "}
                          {topic.metrics.videos} videos
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-4 text-sm text-muted-foreground">
                    No trade knowledge has been indexed yet.
                  </p>
                )}
              </div>

              <div className="rounded-2xl border border-border bg-card/70 p-5">
                <h2 className="text-lg font-bold">System snapshot</h2>
                <div className="mt-4 space-y-3 text-sm">
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-muted-foreground">Graph state</span>
                    <span className="font-semibold text-foreground">
                      {model.counts.nodes ? "Available" : "Empty"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-muted-foreground">
                      Last memory refresh
                    </span>
                    <span className="font-mono text-xs text-foreground">
                      {lastUpdatedLabel}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-muted-foreground">
                      Indexed topics
                    </span>
                    <span className="font-mono text-foreground">{topics}</span>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-muted-foreground">
                      Knowledge links
                    </span>
                    <span className="font-mono text-foreground">
                      {connections}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
