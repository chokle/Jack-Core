import type { ReactNode } from "react";
import { Activity, BookOpen, Compass, Radio, RadioTower } from "lucide-react";
import { JackPet } from "./JackPet";

export type JackPresenceStatus = "ONLINE" | "LISTENING" | "THINKING" | "ERROR";

export interface JackPresenceState {
  status: JackPresenceStatus;
  activity: string;
  context: string;
  memoryState: "AVAILABLE" | "LOADING" | "UNAVAILABLE";
  /** Pass only when supplied by Radio Jack's owning session. */
  radioState?: "READY" | "LISTENING" | "SPEAKING";
  /** Pass only when supplied by the canonical Radar session. */
  radarState?: "ACTIVE" | "IDLE";
  displayMode?: "COMPACT" | "DETAIL";
  /** Existing, verified citations for the current response. Omit when unavailable. */
  sourceCount?: number;
}

export function buildJackPresenceState(input: {
  workspace: string;
  memoryLoading: boolean;
  memoryError: boolean;
  askJackOpen: boolean;
  sourceCount?: number;
}): JackPresenceState {
  const status = input.memoryError
    ? "ERROR"
    : input.memoryLoading
      ? "THINKING"
      : "ONLINE";
  return {
    status,
    activity: input.memoryError
      ? "LIVING MEMORY UNAVAILABLE"
      : input.memoryLoading
        ? "LOADING LIVING MEMORY"
        : input.askJackOpen
          ? "ASK JACK · OPEN"
          : "FIELD INTELLIGENCE",
    context: input.workspace,
    memoryState: input.memoryError
      ? "UNAVAILABLE"
      : input.memoryLoading
        ? "LOADING"
        : "AVAILABLE",
    ...(input.sourceCount === undefined
      ? {}
      : { sourceCount: input.sourceCount }),
  };
}

const statusTone: Record<JackPresenceStatus, string> = {
  ONLINE: "bg-emerald-400",
  LISTENING: "bg-primary animate-pulse",
  THINKING: "bg-amber-400 animate-pulse",
  ERROR: "bg-destructive",
};

export function JackPresence({ state }: { state: JackPresenceState }) {
  return (
    <section
      aria-label="Jack presence"
      data-status={state.status.toLowerCase()}
      className="mx-3 my-3 overflow-hidden rounded-xl border border-primary/30 bg-gradient-to-br from-primary/10 via-card/70 to-card/40 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
    >
      <div className="flex items-center gap-3">
        <JackPet
          activity={state.status === "ERROR" ? "ALERT" : state.status}
          size={40}
          label="Jack, field intelligence"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="font-black tracking-wide">JACK</div>
            <div className="flex items-center gap-1.5 font-mono text-[9px] font-bold tracking-wider text-muted-foreground">
              <span
                className={`h-1.5 w-1.5 rounded-full ${statusTone[state.status]}`}
              />
              {state.status}
            </div>
          </div>
          <div className="truncate font-mono text-[9px] uppercase tracking-[0.13em] text-muted-foreground">
            {state.activity}
          </div>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-2 gap-y-2 border-t border-sidebar-border/70 pt-2.5 text-[10px]">
        <PresenceFact
          icon={<Activity className="h-3 w-3" />}
          label="ROLE"
          value="Crew memory + field support"
        />
        <PresenceFact
          icon={<BookOpen className="h-3 w-3" />}
          label="MEMORY"
          value={
            state.memoryState === "LOADING"
              ? "Loading"
              : state.memoryState === "UNAVAILABLE"
                ? "Unavailable"
                : "Living · available"
          }
        />
        <PresenceFact
          icon={<Radio className="h-3 w-3" />}
          label="SOURCES"
          value={
            state.sourceCount === undefined
              ? "Cited in answers"
              : `${state.sourceCount} cited`
          }
        />
        <PresenceFact
          icon={<RadioTower className="h-3 w-3" />}
          label="COMMS"
          value={
            state.radioState
              ? `Radio Jack · ${state.radioState.toLowerCase()}`
              : "Radio Jack"
          }
        />
        <PresenceFact
          icon={<RadioTower className="h-3 w-3" />}
          label="CONTEXT"
          value={state.context}
        />
        {state.radarState && (
          <PresenceFact
            icon={<Compass className="h-3 w-3" />}
            label="RADAR"
            value={state.radarState}
          />
        )}
      </div>
    </section>
  );
}

function PresenceFact({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1 font-mono text-[8px] tracking-wider text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="whitespace-normal break-words pl-4 text-[9px] font-medium leading-3 text-foreground/85">
        {value}
      </div>
    </div>
  );
}
