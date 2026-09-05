import { useEffect, useId, useReducer, useRef, useState } from "react";
import {
  Layers3,
  MapPin,
  Radio,
  TriangleAlert,
  Users,
  Wifi,
  X,
} from "lucide-react";
import {
  connectivityReducer,
  initialConnectivityState,
  projectSiteHud,
  type HudCrewMember,
  type HudSiteContext,
  type HudWorkerInput,
  type PositionStatus,
} from "../lib/site-hud";
import "./SiteHud.css";

interface SiteHudProps {
  site: HudSiteContext;
  workers: readonly HudWorkerInput[];
  clock?: () => number;
}

type Panel = "floors" | "crew" | "safety" | "alerts" | "signal";
const panelLabels: Record<Panel, string> = {
  floors: "Floor / elevation",
  crew: "Crew roster",
  safety: "Safety landmarks",
  alerts: "Site alerts",
  signal: "Signal / simulation",
};
const panelIcons = {
  floors: Layers3,
  crew: Users,
  safety: MapPin,
  alerts: TriangleAlert,
  signal: Radio,
};
const statuses: PositionStatus[] = [
  "LIVE",
  "DIRECT",
  "RELAYED",
  "LAST KNOWN",
  "SIGNAL LOST",
];
const clockNow = () => Date.now();
const browserIsOnline = () =>
  typeof navigator === "undefined" || navigator.onLine;
const sourceLabel = (source: HudCrewMember["source"]) =>
  source === "cloud"
    ? "Cloud sample"
    : source === "local-direct"
      ? "Direct local sample"
      : source === "local-relay"
        ? "Relayed local sample"
        : "No source";
const timeLabel = (timestamp: number | null) =>
  timestamp === null
    ? "No timestamp"
    : `${new Date(timestamp).toISOString().slice(11, 19)} UTC`;
const ageLabel = (ageMs: number | null) =>
  ageMs === null
    ? "Age unknown"
    : ageMs < 60_000
      ? `${Math.floor(ageMs / 1_000)}s old`
      : `${Math.floor(ageMs / 60_000)}m old`;

function PositionMark({ status }: { status: PositionStatus }) {
  if (status === "DIRECT")
    return <path d="M0 -4 4 0 0 4 -4 0Z" fill="currentColor" />;
  if (status === "SIGNAL LOST")
    return (
      <path d="m-3-3 6 6m0-6-6 6" stroke="currentColor" strokeWidth="1.5" />
    );
  return (
    <circle
      r={status === "LIVE" ? 3 : 4}
      fill={status === "LIVE" ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.5"
      strokeDasharray={status === "LAST KNOWN" ? "2 2" : undefined}
    />
  );
}

/** An explicit, ephemeral demo. Browser connectivity never proves cloud or radio connectivity. */
export function SiteHud({ site, workers, clock = clockNow }: SiteHudProps) {
  const uid = useId();
  const [nowMs, setNowMs] = useState(clock);
  const [browserOnline, setBrowserOnline] = useState(browserIsOnline);
  const [connectivity, dispatch] = useReducer(
    connectivityReducer,
    undefined,
    () =>
      browserIsOnline()
        ? initialConnectivityState
        : connectivityReducer(initialConnectivityState, {
            type: "disconnected",
          }),
  );
  const simulatedOffline = useRef(false);
  const eventSequence = useRef(0);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [selectedFloor, setSelectedFloor] = useState(site.floors[0]?.id ?? "");
  const panelRef = useRef<HTMLDivElement>(null);
  const panelButtons = useRef<Partial<Record<Panel, HTMLButtonElement | null>>>(
    {},
  );

  useEffect(() => {
    const offline = () => {
      setBrowserOnline(false);
      dispatch({ type: "disconnected" });
    };
    const online = () => {
      const available = browserIsOnline();
      setBrowserOnline(available);
      if (!available) dispatch({ type: "disconnected" });
      else if (!simulatedOffline.current) dispatch({ type: "reconnected" });
    };
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    const timer = window.setInterval(() => setNowMs(clock()), 1_000);
    return () => {
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
      window.clearInterval(timer);
    };
  }, [clock]);

  useEffect(() => {
    if (panel) panelRef.current?.focus();
  }, [panel]);

  const view = projectSiteHud(site, workers, {
    nowMs,
    connectivity: connectivity.mode,
  });
  const floor =
    view.floors.find((item) => item.id === selectedFloor) ?? view.floors[0];
  const plottedCrew = view.crew.filter(
    (member) => member.position?.floorId === floor?.id,
  );
  const offline = connectivity.mode !== "ONLINE";
  const LinkIcon = offline ? Radio : Wifi;
  const closePanel = () => {
    if (panel) panelButtons.current[panel]?.focus();
    setPanel(null);
  };
  const describeMember = (member: HudCrewMember) =>
    `${member.name}; ${member.status}; ${sourceLabel(member.source)}; ${timeLabel(member.observedAt)}; ${ageLabel(member.ageMs)}${member.stale ? "; location may have changed" : ""}`;

  return (
    <section
      className="site-hud"
      data-mode={connectivity.mode}
      aria-label="Site HUD simulation"
      onKeyDown={(event) => {
        if (event.key === "Escape" && panel) {
          event.stopPropagation();
          closePanel();
        }
      }}
    >
      <div className="site-hud__instrument">
        <div className="site-hud__heading">
          <span>SITE HUD</span>
          <span className="site-hud__demo">SIMULATION</span>
        </div>
        <div className="site-hud__overview">
          <svg
            className="site-hud__radar"
            viewBox="0 0 120 120"
            role="group"
            aria-label={`Schematic radar: ${floor?.label ?? "no floor"}. Not for navigation.`}
          >
            <g
              className="site-hud__grid"
              fill="none"
              stroke="currentColor"
              strokeWidth="0.6"
            >
              <circle cx="60" cy="60" r="51" />
              <circle cx="60" cy="60" r="34" />
              <circle cx="60" cy="60" r="17" />
              <path d="M60 5v110M5 60h110M24 24l72 72m0-72-72 72" />
              <path
                d="M14 40h30V22h45v36h16v39H54V84H14Z"
                strokeDasharray="3 3"
              />
            </g>
            {view.landmarks
              .filter((landmark) => landmark.floorId === floor?.id)
              .map((landmark) => (
                <g
                  key={landmark.id}
                  transform={`translate(${10 + landmark.x},${10 + landmark.y})`}
                  role="img"
                  aria-label={`Simulated ${landmark.kind}: ${landmark.label}`}
                >
                  <title>
                    {landmark.label} · simulated {landmark.kind}
                  </title>
                  <path
                    d="M-3 3 0-3 3 3Z"
                    className="site-hud__landmark-mark"
                  />
                </g>
              ))}
            {plottedCrew.map((member) => (
              <g
                key={member.id}
                transform={`translate(${10 + member.position!.x},${10 + member.position!.y})`}
                role="img"
                aria-label={describeMember(member)}
                tabIndex={0}
              >
                <title>{describeMember(member)}</title>
                <PositionMark status={member.status} />
              </g>
            ))}
            <text
              x="60"
              y="118"
              textAnchor="middle"
              className="site-hud__schematic-label"
            >
              SCHEMATIC · NO SCALE
            </text>
          </svg>
          <div className="site-hud__readout">
            <div className="site-hud__mode" role="status">
              <LinkIcon size={15} aria-hidden="true" />
              <span>{connectivity.mode}</span>
            </div>
            <span className="site-hud__floor-label">
              {floor?.label ?? "No floor"}
            </span>
            <span className="site-hud__crew-count">
              <strong>{plottedCrew.length}</strong> positions
            </span>
            <span className="site-hud__muted">
              {view.crew.length} scoped crew
            </span>
          </div>
        </div>
        <div className="site-hud__controls" aria-label="Site HUD panels">
          {(Object.keys(panelLabels) as Panel[]).map((key) => {
            const Icon = panelIcons[key];
            return (
              <button
                key={key}
                type="button"
                ref={(node) => {
                  panelButtons.current[key] = node;
                }}
                aria-label={panelLabels[key]}
                title={panelLabels[key]}
                aria-expanded={panel === key}
                aria-controls={`${uid}-${key}`}
                onClick={() => setPanel(panel === key ? null : key)}
              >
                <Icon size={15} aria-hidden="true" />
                {key === "alerts" && view.alerts.length > 0 && (
                  <span className="site-hud__alert-dot" aria-hidden="true" />
                )}
              </button>
            );
          })}
        </div>
        <p className="site-hud__disclaimer">
          Simulated data · Not for navigation
        </p>
      </div>

      {panel && (
        <div
          className="site-hud__panel"
          id={`${uid}-${panel}`}
          role="region"
          aria-labelledby={`${uid}-panel-title`}
          tabIndex={-1}
          ref={panelRef}
        >
          <div className="site-hud__panel-heading">
            <h2 id={`${uid}-panel-title`}>{panelLabels[panel]}</h2>
            <button
              type="button"
              aria-label="Close Site HUD panel"
              onClick={closePanel}
            >
              <X size={18} aria-hidden="true" />
            </button>
          </div>
          <p className="site-hud__site-name">{view.siteName}</p>
          {panel === "floors" && (
            <>
              <p className="site-hud__help">
                Choose a simulated floor. Elevations are plan references, not
                measured device altitude.
              </p>
              <div className="site-hud__floor-list">
                {view.floors.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    aria-pressed={floor?.id === item.id}
                    onClick={() => setSelectedFloor(item.id)}
                  >
                    <Layers3 size={16} aria-hidden="true" />
                    <span>{item.label}</span>
                    <span>{item.elevationMeters} m</span>
                  </button>
                ))}
              </div>
              <p className="site-hud__help">
                Radar shows scoped crew with a retained position on the selected
                floor. Lost signals have no plotted position.
              </p>
            </>
          )}
          {panel === "crew" && (
            <>
              <p className="site-hud__help">
                Only explicitly scoped demo contractors are named. Other fresh
                nearby samples appear as a count.
              </p>
              <p className="site-hud__anonymous">
                Other nearby:{" "}
                <strong>{view.anonymousProximity.nearbyCount}</strong> ·
                anonymous
              </p>
              <ul className="site-hud__list">
                {view.crew.map((member) => (
                  <li key={member.id}>
                    <div className="site-hud__row">
                      <strong>{member.name}</strong>
                      <span className="site-hud__confidence">
                        {member.status}
                      </span>
                    </div>
                    <p>
                      {member.trade} ·{" "}
                      {member.position
                        ? view.floors.find(
                            (item) => item.id === member.position?.floorId,
                          )?.label
                        : "Position unavailable"}
                    </p>
                    <p>
                      {sourceLabel(member.source)} · {ageLabel(member.ageMs)}
                    </p>
                    <p>
                      <time
                        dateTime={
                          member.observedAt === null
                            ? undefined
                            : new Date(member.observedAt).toISOString()
                        }
                      >
                        {timeLabel(member.observedAt)}
                      </time>
                      {member.stale ? " · May have moved" : ""}
                    </p>
                  </li>
                ))}
              </ul>
              {view.crew.length === 0 && (
                <p className="site-hud__help">
                  No crew in the granted demo scope.
                </p>
              )}
              <div
                className="site-hud__legend"
                aria-label="Position confidence legend"
              >
                {statuses.map((status) => (
                  <span key={status}>
                    <svg viewBox="-6 -6 12 12" aria-hidden="true">
                      <PositionMark status={status} />
                    </svg>
                    {status}
                  </span>
                ))}
              </div>
              <p className="site-hud__help">
                LIVE: fresh cloud sample. DIRECT: local sample. RELAYED:
                forwarded sample. LAST KNOWN: stale or cloud unavailable. SIGNAL
                LOST: no usable position. All are simulated.
              </p>
            </>
          )}
          {panel === "safety" && (
            <>
              <p className="site-hud__help">
                Illustrative plan markers only. Follow actual site signage and
                your site safety procedures.
              </p>
              <ul className="site-hud__list">
                {view.landmarks.map((landmark) => (
                  <li key={landmark.id}>
                    <div className="site-hud__row">
                      <strong>{landmark.label}</strong>
                      <span>{landmark.kind}</span>
                    </div>
                    <p>
                      {view.floors.find((item) => item.id === landmark.floorId)
                        ?.label ?? "Floor unknown"}{" "}
                      · simulated landmark
                    </p>
                  </li>
                ))}
              </ul>
            </>
          )}
          {panel === "alerts" && (
            <>
              <p className="site-hud__help">
                Demo data-quality notices. This is not an emergency monitoring
                service.
              </p>
              <ul className="site-hud__list">
                {view.alerts.map((alert) => (
                  <li key={alert.id}>
                    <div className="site-hud__row">
                      <TriangleAlert size={15} aria-hidden="true" />
                      <span>{alert.message}</span>
                    </div>
                  </li>
                ))}
              </ul>
              {view.alerts.length === 0 && (
                <p className="site-hud__help">No demo data-quality notices.</p>
              )}
            </>
          )}
          {panel === "signal" && (
            <>
              <div className="site-hud__signal-state">
                <LinkIcon size={20} aria-hidden="true" />
                <strong>{connectivity.mode}</strong>
              </div>
              <p className="site-hud__help">
                {offline
                  ? "Off the grid: in-memory and simulated local observations only."
                  : "Browser connection available. Cloud service availability is not verified."}
              </p>
              <p className="site-hud__help">
                No radio scan, peer discovery, or real sync. Direct and relayed
                links are fixture samples. Observations age without refreshing.
              </p>
              <p className="site-hud__anonymous">
                Demo queue: <strong>{connectivity.pendingEvents.length}</strong>{" "}
                pending
                {connectivity.droppedEvents > 0
                  ? ` · ${connectivity.droppedEvents} dropped (queue full)`
                  : ""}
              </p>
              <div className="site-hud__demo-controls">
                <button
                  type="button"
                  disabled={connectivity.mode === "OTG"}
                  onClick={() => {
                    simulatedOffline.current = true;
                    dispatch({ type: "disconnected" });
                  }}
                >
                  Simulate reception loss
                </button>
                <button
                  type="button"
                  disabled={connectivity.mode !== "OTG" || !browserOnline}
                  onClick={() => {
                    if (!browserIsOnline()) return;
                    simulatedOffline.current = false;
                    dispatch({ type: "reconnected" });
                  }}
                >
                  Simulate reconnect
                </button>
                <button
                  type="button"
                  disabled={!offline}
                  onClick={() => {
                    dispatch({
                      type: "local-event",
                      id: `demo-check-in-${++eventSequence.current}`,
                      createdAt: clock(),
                    });
                  }}
                >
                  Record demo check-in
                </button>
                <button
                  type="button"
                  disabled={
                    connectivity.mode !== "OTG SYNCING" || !browserOnline
                  }
                  onClick={() => {
                    if (!browserIsOnline() || simulatedOffline.current) return;
                    dispatch({
                      type: "sync-completed",
                      generation: connectivity.generation,
                    });
                  }}
                >
                  Reconcile demo queue
                </button>
              </div>
              {!browserOnline && (
                <p className="site-hud__help">
                  Browser is offline. Reconnect is unavailable until the browser
                  returns online.
                </p>
              )}
              {connectivity.mode === "OTG SYNCING" && (
                <p className="site-hud__help">
                  Awaiting explicit demo reconciliation. No successful server
                  sync is implied.
                </p>
              )}
              <p className="site-hud__help">
                Demo events stay in memory for this tab and are discarded when
                the demo closes. Reconciliation transmits nothing.
              </p>
            </>
          )}
          <p className="site-hud__panel-footer">
            SIMULATION · NOT FOR NAVIGATION
          </p>
        </div>
      )}
    </section>
  );
}
