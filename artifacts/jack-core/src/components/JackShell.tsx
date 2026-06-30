import type { ReactNode } from "react";
import {
  Bot,
  Network,
  LayoutGrid,
  LayoutDashboard,
  GraduationCap,
  Lightbulb,
  Settings,
} from "lucide-react";
import type { GraphModel } from "../lib/memory-graph";

export type JackView = "graph" | "library";

interface JackShellProps {
  active: JackView;
  onNavigate: (v: JackView) => void;
  onOpenChat: () => void;
  model: GraphModel;
  readyCount: number;
  lastUpdatedLabel: string;
  children: ReactNode;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

export function JackShell({
  active,
  onNavigate,
  onOpenChat,
  model,
  readyCount,
  lastUpdatedLabel,
  children,
}: JackShellProps) {
  const stats: { label: string; value: string; accent?: boolean }[] = [
    { label: "Total Nodes", value: fmt(model.counts.nodes), accent: true },
    { label: "Connections", value: fmt(model.counts.connections), accent: true },
    { label: "Topics", value: fmt(model.counts.topics) },
    { label: "Videos Processed", value: fmt(readyCount) },
  ];

  return (
    <div className="relative z-10 flex h-screen w-full overflow-hidden text-foreground selection:bg-primary/30">
      <aside className="hidden md:flex w-60 flex-col border-r border-sidebar-border bg-sidebar/85 backdrop-blur-md">
        {/* Brand */}
        <button
          onClick={() => onNavigate("graph")}
          className="flex flex-col items-start gap-0.5 px-5 py-5 text-left"
        >
          <div className="flex items-baseline gap-1.5">
            <span className="text-xl font-extrabold tracking-tight">JACK</span>
            <span className="text-xl font-extrabold tracking-tight text-primary">
              CORE
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Memory Graph
            </span>
            <span className="flex items-center gap-1 text-[10px] font-semibold text-emerald-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
              LIVE
            </span>
          </div>
        </button>

        {/* Nav */}
        <nav className="flex flex-col gap-1 px-3 py-2">
          <NavItem
            icon={<Bot className="h-4 w-4" />}
            label="Ask Jack"
            onClick={onOpenChat}
          />
          <NavItem
            icon={<Network className="h-4 w-4" />}
            label="Memory Graph"
            active={active === "graph"}
            onClick={() => onNavigate("graph")}
          />
          <NavItem
            icon={<LayoutGrid className="h-4 w-4" />}
            label="Library"
            active={active === "library"}
            onClick={() => onNavigate("library")}
          />
          <NavItem icon={<LayoutDashboard className="h-4 w-4" />} label="Dashboard" soon />
          <NavItem icon={<GraduationCap className="h-4 w-4" />} label="Competencies" soon />
          <NavItem icon={<Lightbulb className="h-4 w-4" />} label="Insights" soon />
          <NavItem icon={<Settings className="h-4 w-4" />} label="Settings" soon />
        </nav>

        {/* Graph stats */}
        <div className="mx-4 mt-4 rounded-xl border border-sidebar-border/80 bg-card/40 p-4">
          <div className="mb-3 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Graph Stats
          </div>
          <div className="space-y-2.5">
            {stats.map((s) => (
              <div key={s.label} className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">{s.label}</span>
                <span
                  className={`font-mono text-sm font-bold tabular-nums ${
                    s.accent ? "text-primary" : "text-foreground"
                  }`}
                >
                  {s.value}
                </span>
              </div>
            ))}
            <div className="border-t border-sidebar-border/70 pt-2.5">
              <div className="text-xs text-muted-foreground">Last Updated</div>
              <div className="font-mono text-sm font-semibold text-foreground">
                {lastUpdatedLabel}
              </div>
            </div>
          </div>
        </div>

        <div className="flex-1" />

        {/* Identity */}
        <div className="flex items-center gap-3 border-t border-sidebar-border px-4 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-[0_0_15px_rgba(255,100,0,0.35)]">
            <span className="text-sm font-black">J</span>
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">Jack</div>
            <div className="truncate text-xs text-muted-foreground">
              Trade Intelligence
            </div>
          </div>
        </div>
      </aside>

      <main className="relative flex flex-1 overflow-hidden">{children}</main>
    </div>
  );
}

function NavItem({
  icon,
  label,
  active,
  soon,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  soon?: boolean;
  onClick?: () => void;
}) {
  if (soon) {
    return (
      <div
        className="flex items-center justify-between rounded-lg px-3 py-2 text-sm text-muted-foreground/45"
        title="Coming soon"
      >
        <span className="flex items-center gap-3">
          {icon}
          {label}
        </span>
        <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground/40">
          soon
        </span>
      </div>
    );
  }
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
        active
          ? "bg-primary/15 font-semibold text-primary"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
