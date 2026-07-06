import { useState, type ReactNode } from "react";
import {
  Bot,
  Network,
  LayoutGrid,
  LayoutDashboard,
  GraduationCap,
  Lightbulb,
  Mic,
  Settings,
  Menu,
  ShieldCheck,
  X,
  LogOut,
  Radio,
} from "lucide-react";
import type { GraphModel } from "../lib/memory-graph";
import { SystemHealthWidget } from "./SystemHealthWidget";

export type JackView = "graph" | "library" | "interview" | "review";

interface JackShellProps {
  active: JackView;
  onNavigate: (v: JackView) => void;
  onOpenChat: () => void;
  model: GraphModel;
  readyCount: number;
  lastUpdatedLabel: string;
  userLabel?: string;
  userSubLabel?: string;
  onSignOut?: () => void;
  /** Opens the beta user-testing consent modal. Omit to hide the control entirely. */
  onStartUserTest?: () => void;
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
  userLabel,
  userSubLabel,
  onSignOut,
  onStartUserTest,
  children,
}: JackShellProps) {
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const avatarInitial = (userLabel?.trim()?.charAt(0) || "J").toUpperCase();

  const go = (v: JackView) => {
    onNavigate(v);
    setIsPanelOpen(false);
  };

  const openChat = () => {
    onOpenChat();
    setIsPanelOpen(false);
  };

  const stats: { label: string; value: string; accent?: boolean }[] = [
    { label: "Total Nodes", value: fmt(model.counts.nodes), accent: true },
    { label: "Connections", value: fmt(model.counts.connections), accent: true },
    { label: "Concepts", value: fmt(model.counts.knowledge), accent: true },
    { label: "Topics", value: fmt(model.counts.topics) },
    { label: "Videos Processed", value: fmt(readyCount) },
  ];

  return (
    <div className="relative z-10 flex h-screen w-full flex-col overflow-hidden text-foreground selection:bg-primary/30 md:flex-row">
      <header className="flex shrink-0 items-center justify-between border-b border-sidebar-border bg-sidebar/85 px-4 py-3 backdrop-blur-md md:hidden">
        <button onClick={() => go("graph")} className="flex items-baseline gap-1.5">
          <span className="text-lg font-extrabold tracking-tight">JACK</span>
          <span className="text-lg font-extrabold tracking-tight text-primary">CORE</span>
        </button>
        <SystemHealthWidget />
        <button
          type="button"
          onClick={() => setIsPanelOpen(true)}
          aria-label="Open menu"
          aria-expanded={isPanelOpen}
          className="flex min-h-11 items-center gap-2 rounded-lg border border-sidebar-border bg-card/60 px-3 py-2 text-sm font-semibold text-foreground transition-colors hover:bg-muted/60"
        >
          <Menu className="h-4 w-4 text-primary" />
          Menu
        </button>
      </header>

      {isPanelOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm md:hidden"
          onClick={() => setIsPanelOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-[85vw] max-w-[320px] transform flex-col overflow-y-auto bg-sidebar backdrop-blur-md transition-transform duration-300 ease-out md:static md:z-auto md:w-60 md:max-w-none md:translate-x-0 md:bg-sidebar/85 md:transition-none ${
          isPanelOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center justify-end px-3 pt-3 md:hidden">
          <button
            type="button"
            onClick={() => setIsPanelOpen(false)}
            aria-label="Close menu"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Brand */}
        <button
          onClick={() => go("graph")}
          className="flex flex-col items-start gap-0.5 px-5 py-5 text-left"
        >
          <div className="flex items-baseline gap-1.5">
            <span className="text-xl font-extrabold tracking-tight">JACK</span>
            <span className="text-xl font-extrabold tracking-tight text-primary">
              CORE
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Memory Graph
            </span>
            <SystemHealthWidget />
          </div>
        </button>

        {/* Nav */}
        <nav className="flex flex-col gap-1 px-3 py-2">
          <NavItem
            icon={<Bot className="h-4 w-4" />}
            label="Ask Jack"
            onClick={openChat}
            testId="open-chat"
          />
          <NavItem
            icon={<Network className="h-4 w-4" />}
            label="Memory Graph"
            active={active === "graph"}
            onClick={() => go("graph")}
          />
          <NavItem
            icon={<LayoutGrid className="h-4 w-4" />}
            label="Library"
            active={active === "library"}
            onClick={() => go("library")}
          />
          <NavItem
            icon={<Mic className="h-4 w-4" />}
            label="Interview"
            active={active === "interview"}
            onClick={() => go("interview")}
          />
          <NavItem
            icon={<ShieldCheck className="h-4 w-4" />}
            label="Review"
            active={active === "review"}
            onClick={() => go("review")}
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
        <div className="border-t border-sidebar-border px-4 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-[0_0_15px_rgba(255,100,0,0.35)]">
              <span className="text-sm font-black">{avatarInitial}</span>
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">
                {userLabel ?? "Jack"}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {userSubLabel ?? "Trade Intelligence"}
              </div>
            </div>
          </div>
          {onStartUserTest && (
            <button
              type="button"
              onClick={onStartUserTest}
              data-testid="start-user-test"
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-sidebar-border bg-card/50 px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            >
              <Radio className="h-4 w-4" />
              Start User Test
            </button>
          )}
          {onSignOut && (
            <button
              type="button"
              onClick={onSignOut}
              data-testid="sign-out"
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-sidebar-border bg-card/50 px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          )}
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
  testId,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  soon?: boolean;
  onClick?: () => void;
  testId?: string;
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
      data-testid={testId}
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
