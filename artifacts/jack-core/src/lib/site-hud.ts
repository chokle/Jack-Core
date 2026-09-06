/** Deterministic, simulated Site HUD data. No radio, storage, or network adapter. */
export const SITE_HUD_FRESH_MS = 15_000;
export const SITE_HUD_SIGNAL_LOST_MS = 120_000;
export const SITE_HUD_QUEUE_LIMIT = 20;

export type ConnectivityMode = "ONLINE" | "OTG" | "OTG SYNCING";
export type PositionSource = "cloud" | "local-direct" | "local-relay";
export type PositionStatus =
  | "LIVE"
  | "DIRECT"
  | "RELAYED"
  | "LAST KNOWN"
  | "SIGNAL LOST";

export interface HudFloor {
  id: string;
  label: string;
  elevationMeters: number;
}

export interface HudPosition {
  /** Coordinates on the simulated plan, from 0 to 100. */
  x: number;
  y: number;
  floorId: string;
}

export interface HudLandmark extends HudPosition {
  id: string;
  label: string;
  kind: "entry" | "hazard" | "muster" | "fire-exit" | "first-aid" | "air-horn";
}

export interface HudSiteContext {
  id: string;
  name: string;
  viewerContractorId: string | null;
  /** Explicit fixture scope; never infer grants from a worker name or trade. */
  authorizedContractorIds: readonly string[];
  floors: readonly HudFloor[];
  landmarks: readonly HudLandmark[];
}

export interface HudWorkerInput {
  id: string;
  siteId: string;
  contractorId: string | null;
  name: string;
  trade: string;
  nearby: boolean;
  observation: {
    source: PositionSource;
    observedAt: number;
    position: HudPosition;
  } | null;
}

export interface HudCrewMember {
  id: string;
  name: string;
  trade: string;
  contractorId: string;
  status: PositionStatus;
  source: PositionSource | null;
  observedAt: number | null;
  ageMs: number | null;
  stale: boolean;
  position: HudPosition | null;
}

export interface HudAlert {
  id: string;
  severity: "info" | "warning";
  message: string;
}

export interface HudView {
  siteId: string;
  siteName: string;
  floors: readonly HudFloor[];
  landmarks: readonly HudLandmark[];
  crew: HudCrewMember[];
  /** Outside the granted contractor scope, only this total leaves the model. */
  anonymousProximity: { nearbyCount: number };
  alerts: HudAlert[];
}

function hasId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validTimestamp(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= 8_640_000_000_000_000;
}

function projectPosition(
  worker: HudWorkerInput,
  site: HudSiteContext,
  nowMs: number,
  connectivity: ConnectivityMode,
): Pick<
  HudCrewMember,
  "status" | "source" | "observedAt" | "ageMs" | "stale" | "position"
> {
  const observation = worker.observation;
  const validSource =
    observation &&
    ["cloud", "local-direct", "local-relay"].includes(observation.source);
  const validTime =
    observation &&
    validTimestamp(nowMs) &&
    validTimestamp(observation.observedAt) &&
    observation.observedAt <= nowMs;
  const ageMs = validTime ? nowMs - observation.observedAt : null;
  const position = observation?.position;
  const validPosition =
    position &&
    site.floors.some((floor) => floor.id === position.floorId) &&
    Number.isFinite(position.x) &&
    Number.isFinite(position.y) &&
    position.x >= 0 &&
    position.x <= 100 &&
    position.y >= 0 &&
    position.y <= 100;
  const source = validSource ? observation.source : null;
  const observedAt = validTime ? observation.observedAt : null;
  if (
    !validPosition ||
    !source ||
    ageMs === null ||
    ageMs >= SITE_HUD_SIGNAL_LOST_MS
  ) {
    return {
      status: "SIGNAL LOST",
      source,
      observedAt,
      ageMs,
      stale: true,
      position: null,
    };
  }
  const stale =
    ageMs >= SITE_HUD_FRESH_MS ||
    (source === "cloud" && connectivity !== "ONLINE");
  const status: PositionStatus = stale
    ? "LAST KNOWN"
    : source === "local-direct"
      ? "DIRECT"
      : source === "local-relay"
        ? "RELAYED"
        : "LIVE";
  return {
    status,
    source,
    observedAt,
    ageMs,
    stale,
    position: { x: position.x, y: position.y, floorId: position.floorId },
  };
}

/** A local fixture projection, not a substitute for server-enforced authorization. */
export function projectSiteHud(
  site: HudSiteContext,
  workers: readonly HudWorkerInput[],
  { nowMs, connectivity }: { nowMs: number; connectivity: ConnectivityMode },
): HudView {
  const view: HudView = {
    siteId: site.id,
    siteName: site.name,
    floors: site.floors.map(({ id, label, elevationMeters }) => ({
      id,
      label,
      elevationMeters,
    })),
    landmarks: site.landmarks.map(({ id, label, kind, floorId, x, y }) => ({
      id,
      label,
      kind,
      floorId,
      x,
      y,
    })),
    crew: [],
    anonymousProximity: { nearbyCount: 0 },
    alerts: [],
  };
  // Missing or unknown viewer scope fails closed, including anonymous totals.
  if (
    !hasId(site.id) ||
    !hasId(site.viewerContractorId) ||
    !Array.isArray(site.authorizedContractorIds) ||
    !site.authorizedContractorIds.includes(site.viewerContractorId)
  )
    return view;

  for (const worker of workers) {
    if (worker.siteId !== site.id || !hasId(worker.contractorId)) continue;
    const projected = projectPosition(worker, site, nowMs, connectivity);
    if (!site.authorizedContractorIds.includes(worker.contractorId)) {
      if (worker.nearby && !projected.stale)
        view.anonymousProximity.nearbyCount += 1;
      continue;
    }
    const member: HudCrewMember = {
      id: worker.id,
      name: worker.name,
      trade: worker.trade,
      contractorId: worker.contractorId,
      ...projected,
    };
    view.crew.push(member);
    if (member.stale)
      view.alerts.push({
        id: `position-${member.id}`,
        severity: member.status === "SIGNAL LOST" ? "warning" : "info",
        message:
          member.status === "SIGNAL LOST"
            ? `${member.name}: signal lost; current position unavailable.`
            : `${member.name}: last known position; location may have changed.`,
      });
  }
  return view;
}

export interface SimulatedLocalEvent {
  id: string;
  createdAt: number;
}

export interface ConnectivityState {
  mode: ConnectivityMode;
  generation: number;
  pendingEvents: readonly SimulatedLocalEvent[];
  droppedEvents: number;
  /** Prefix captured by the current simulated sync attempt. */
  syncCount: number;
}

export type ConnectivityEvent =
  | { type: "disconnected" }
  | { type: "reconnected" }
  | { type: "sync-completed"; generation: number }
  | { type: "local-event"; id: string; createdAt: number };

export const initialConnectivityState: ConnectivityState = {
  mode: "ONLINE",
  generation: 0,
  pendingEvents: [],
  droppedEvents: 0,
  syncCount: 0,
};

export function connectivityReducer(
  state: ConnectivityState,
  event: ConnectivityEvent,
): ConnectivityState {
  switch (event.type) {
    case "disconnected":
      return state.mode === "OTG"
        ? state
        : {
            ...state,
            mode: "OTG",
            generation: state.generation + 1,
            syncCount: 0,
          };
    case "reconnected":
      return state.mode !== "OTG"
        ? state
        : {
            ...state,
            mode: "OTG SYNCING",
            generation: state.generation + 1,
            syncCount: state.pendingEvents.length,
          };
    case "sync-completed": {
      if (state.mode !== "OTG SYNCING" || event.generation !== state.generation)
        return state;
      const pendingEvents = state.pendingEvents.slice(state.syncCount);
      return {
        ...state,
        mode: pendingEvents.length ? "OTG SYNCING" : "ONLINE",
        generation: state.generation + 1,
        pendingEvents,
        syncCount: pendingEvents.length,
      };
    }
    case "local-event":
      if (
        state.mode === "ONLINE" ||
        !hasId(event.id) ||
        !validTimestamp(event.createdAt) ||
        state.pendingEvents.some((pending) => pending.id === event.id)
      )
        return state;
      if (state.pendingEvents.length >= SITE_HUD_QUEUE_LIMIT)
        return { ...state, droppedEvents: state.droppedEvents + 1 };
      return {
        ...state,
        pendingEvents: [
          ...state.pendingEvents,
          { id: event.id, createdAt: event.createdAt },
        ],
      };
  }
}

export function createSiteHudFixture(nowMs: number): {
  site: HudSiteContext;
  workers: HudWorkerInput[];
} {
  const site: HudSiteContext = {
    id: "demo-harbour-site",
    name: "Harbour Exchange · Simulated site",
    viewerContractorId: "demo-north-contractor",
    authorizedContractorIds: ["demo-north-contractor"],
    floors: [
      { id: "ground", label: "Ground", elevationMeters: 0 },
      { id: "level-1", label: "Level 1", elevationMeters: 4 },
      { id: "level-2", label: "Level 2", elevationMeters: 8 },
    ],
    landmarks: [
      {
        id: "entry",
        label: "Site entry",
        kind: "entry",
        floorId: "ground",
        x: 14,
        y: 83,
      },
      {
        id: "muster",
        label: "Muster point",
        kind: "muster",
        floorId: "ground",
        x: 82,
        y: 82,
      },
      {
        id: "fire-exit",
        label: "Fire exit",
        kind: "fire-exit",
        floorId: "level-1",
        x: 18,
        y: 78,
      },
      {
        id: "first-aid",
        label: "First aid",
        kind: "first-aid",
        floorId: "ground",
        x: 25,
        y: 77,
      },
      {
        id: "air-horn",
        label: "Air horn",
        kind: "air-horn",
        floorId: "level-2",
        x: 20,
        y: 80,
      },
      {
        id: "lift-zone",
        label: "Simulated lift zone",
        kind: "hazard",
        floorId: "level-1",
        x: 70,
        y: 25,
      },
    ],
  };
  const crew = (
    id: string,
    name: string,
    trade: string,
    source: PositionSource,
    age: number,
    x: number,
    y: number,
    floorId: string,
  ): HudWorkerInput => ({
    id,
    siteId: site.id,
    contractorId: site.viewerContractorId,
    name,
    trade,
    nearby: true,
    observation: {
      source,
      observedAt: nowMs - age,
      position: { x, y, floorId },
    },
  });
  return {
    site,
    workers: [
      crew(
        "demo-avery",
        "Avery Chen",
        "Foreperson",
        "cloud",
        2_000,
        33,
        48,
        "ground",
      ),
      crew(
        "demo-jordan",
        "Jordan Ellis",
        "Electrician",
        "local-direct",
        3_000,
        58,
        42,
        "ground",
      ),
      crew(
        "demo-sam",
        "Sam Morgan",
        "Carpenter",
        "local-relay",
        6_000,
        39,
        56,
        "level-1",
      ),
      crew(
        "demo-riley",
        "Riley Patel",
        "Plumber",
        "cloud",
        45_000,
        61,
        60,
        "level-2",
      ),
      crew(
        "demo-casey",
        "Casey Brooks",
        "Apprentice",
        "local-direct",
        180_000,
        50,
        34,
        "level-1",
      ),
      {
        ...crew(
          "outside-private-1",
          "Outside Private One",
          "Private trade",
          "local-direct",
          4_000,
          74,
          49,
          "level-1",
        ),
        contractorId: "outside-private-contractor",
      },
      {
        ...crew(
          "outside-private-2",
          "Outside Private Two",
          "Private trade",
          "local-relay",
          5_000,
          71,
          46,
          "level-2",
        ),
        contractorId: "outside-private-contractor",
      },
    ],
  };
}
