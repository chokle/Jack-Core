import type { GraphModel } from "../lib/memory-graph";

interface DashboardProps {
  model: GraphModel;
  readyCount: number;
  lastUpdatedLabel: string;
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card/70 p-5 backdrop-blur-sm">
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">{label}</div>
      <div className="mt-2 text-3xl font-black tracking-tight text-foreground">{value}</div>
    </div>
  );
}

export function Dashboard({ model, readyCount, lastUpdatedLabel }: DashboardProps) {
  const nodes = model.counts.nodes.toLocaleString("en-US");
  const connections = model.counts.connections.toLocaleString("en-US");
  const knowledge = model.counts.knowledge.toLocaleString("en-US");
  const topics = model.counts.topics.toLocaleString("en-US");

  const conceptDensity = model.counts.nodes
    ? Math.round((model.counts.knowledge / model.counts.nodes) * 100)
    : 0;
  const connectionDensity = model.counts.nodes
    ? Math.min(
        100,
        Math.round(
          (model.counts.connections / Math.max(1, model.counts.nodes * 2)) * 100,
        ),
      )
    : 0;
  const sourceCoverage = model.counts.topics
    ? Math.min(
        100,
        Math.round((readyCount / Math.max(1, model.counts.topics * 3)) * 100),
      )
    : 0;

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
            A live readout of Jack&apos;s current memory footprint and indexed trade
            knowledge.
          </p>
        </header>

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
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-bold">Memory coverage</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Current graph density across indexed knowledge.
                </p>
              </div>
              <div className="font-mono text-xs text-muted-foreground">
                Updated {lastUpdatedLabel}
              </div>
            </div>
            <div className="mt-5 space-y-4">
              {[
                ["Concept density", conceptDensity],
                ["Connection density", connectionDensity],
                ["Processed source coverage", sourceCoverage],
              ].map(([label, pct]) => (
                <div key={String(label)}>
                  <div className="mb-1 flex items-center justify-between text-sm">
                    <span>{label}</span>
                    <span className="font-mono text-muted-foreground">{pct}%</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary transition-[width]"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-border bg-card/70 p-5">
            <h2 className="text-lg font-bold">System snapshot</h2>
            <div className="mt-4 space-y-3 text-sm">
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">Graph state</span>
                <span className="font-semibold text-foreground">Live</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">Last memory refresh</span>
                <span className="font-mono text-xs text-foreground">
                  {lastUpdatedLabel}
                </span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">Indexed topics</span>
                <span className="font-mono text-foreground">{topics}</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">Knowledge links</span>
                <span className="font-mono text-foreground">{connections}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
