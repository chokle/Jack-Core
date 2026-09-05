import { describe, expect, it } from "vitest";
import {
  connectivityReducer,
  createSiteHudFixture,
  initialConnectivityState,
  projectSiteHud,
  SITE_HUD_FRESH_MS,
  SITE_HUD_QUEUE_LIMIT,
  SITE_HUD_SIGNAL_LOST_MS,
  type ConnectivityState,
  type HudSiteContext,
  type HudWorkerInput,
} from "./site-hud";

const NOW = 1_800_000_000_000;

function fixture() {
  return createSiteHudFixture(NOW);
}

function project(workers?: HudWorkerInput[], site?: HudSiteContext) {
  const data = fixture();
  return projectSiteHud(site ?? data.site, workers ?? data.workers, {
    nowMs: NOW,
    connectivity: "ONLINE",
  });
}

function enqueue(state: ConnectivityState, id: string) {
  return connectivityReducer(state, {
    type: "local-event",
    id,
    createdAt: NOW,
  });
}

describe("simulated Site HUD privacy projection", () => {
  it("projects only the granted contractor crew and a single anonymous proximity total", () => {
    const view = project();
    expect(view.crew.map((worker) => worker.name)).toEqual([
      "Avery Chen",
      "Jordan Ellis",
      "Sam Morgan",
      "Riley Patel",
      "Casey Brooks",
    ]);
    expect(view.anonymousProximity).toEqual({ nearbyCount: 2 });
    const serialized = JSON.stringify(view);
    for (const privateValue of [
      "outside-private",
      "Outside Private",
      "Private trade",
      '"x":74',
      '"y":49',
      '"x":71',
      '"y":46',
    ])
      expect(serialized).not.toContain(privateValue);
    // The aggregate has no drill-down fields or per-worker floor/position records.
    expect(Object.keys(view.anonymousProximity)).toEqual(["nearbyCount"]);
  });

  it("discards cross-site workers, even for an otherwise authorized contractor", () => {
    const { workers } = fixture();
    const foreignWorkers = workers.map((worker) => ({
      ...worker,
      siteId: "another-site",
    }));
    const view = project(foreignWorkers);
    expect(view.crew).toEqual([]);
    expect(view.anonymousProximity.nearbyCount).toBe(0);
    expect(view.alerts).toEqual([]);
    expect(JSON.stringify(view)).not.toContain("Avery");
  });

  it.each([
    { viewerContractorId: null },
    { viewerContractorId: "" },
    { viewerContractorId: "unknown-contractor" },
    { authorizedContractorIds: [] },
    { authorizedContractorIds: undefined },
    { id: "" },
  ])("fails closed for missing or unknown viewer scope: %j", (override) => {
    const { site } = fixture();
    const view = project(undefined, { ...site, ...override } as HudSiteContext);
    expect(view.crew).toEqual([]);
    expect(view.anonymousProximity.nearbyCount).toBe(0);
    expect(view.alerts).toEqual([]);
  });

  it("omits workers without contractor scope rather than assigning them by name", () => {
    const { workers } = fixture();
    const view = project(
      workers.map((worker, index) => ({
        ...worker,
        contractorId: index % 2 ? null : " ",
      })),
    );
    expect(view.crew).toEqual([]);
    expect(view.anonymousProximity.nearbyCount).toBe(0);
  });

  it("honors an explicit additional contractor grant and removes identity when revoked", () => {
    const { site, workers } = fixture();
    const grantedSite = {
      ...site,
      authorizedContractorIds: [
        ...site.authorizedContractorIds,
        "outside-private-contractor",
      ],
    };
    expect(project(workers, grantedSite).crew).toHaveLength(7);
    expect(project(workers, grantedSite).anonymousProximity.nearbyCount).toBe(
      0,
    );
    const revokedView = project(workers, site);
    expect(revokedView.crew).toHaveLength(5);
    expect(JSON.stringify(revokedView)).not.toContain("outside-private");
  });

  it("never reports stale or distant outside-crew observations as current nearby presence", () => {
    const { site, workers } = fixture();
    const outside = workers.filter(
      (worker) => worker.contractorId !== site.viewerContractorId,
    );
    expect(
      project(outside.map((worker) => ({ ...worker, nearby: false })))
        .anonymousProximity.nearbyCount,
    ).toBe(0);
    const staleView = projectSiteHud(site, outside, {
      nowMs: NOW + SITE_HUD_FRESH_MS,
      connectivity: "ONLINE",
    });
    expect(staleView.anonymousProximity.nearbyCount).toBe(0);
  });
});

describe("position confidence and fixture clock", () => {
  it("covers all confidence states, timestamped sources, floors and safety landmarks deterministically", () => {
    expect(fixture()).toEqual(fixture());
    const view = project();
    expect(view.crew.map((worker) => worker.status)).toEqual([
      "LIVE",
      "DIRECT",
      "RELAYED",
      "LAST KNOWN",
      "SIGNAL LOST",
    ]);
    expect(
      view.crew.every((worker) => worker.source && worker.observedAt !== null),
    ).toBe(true);
    expect(view.floors).toHaveLength(3);
    expect(view.landmarks.map((landmark) => landmark.kind)).toEqual(
      expect.arrayContaining(["muster", "fire-exit", "first-aid", "air-horn"]),
    );
    expect(
      view.landmarks.every((landmark) =>
        view.floors.some((floor) => floor.id === landmark.floorId),
      ),
    ).toBe(true);
    expect(view.alerts).toHaveLength(2);
  });

  it.each(["OTG", "OTG SYNCING"] as const)(
    "degrades cloud confidence during %s while local direct/relay sources remain independent",
    (connectivity) => {
      const { site, workers } = fixture();
      const view = projectSiteHud(site, workers, { nowMs: NOW, connectivity });
      expect(view.crew.map((worker) => worker.status)).toEqual([
        "LAST KNOWN",
        "DIRECT",
        "RELAYED",
        "LAST KNOWN",
        "SIGNAL LOST",
      ]);
      expect(view.crew[0].stale).toBe(true);
      expect(view.crew[0].position).not.toBeNull();
      expect(view.anonymousProximity.nearbyCount).toBe(2);
    },
  );

  it("degrades exactly at the age boundaries and never retains current position after signal loss", () => {
    const { site, workers } = fixture();
    const worker = workers[1];
    const observedAt = worker.observation!.observedAt;
    const at = (age: number) =>
      projectSiteHud(site, [worker], {
        nowMs: observedAt + age,
        connectivity: "ONLINE",
      }).crew[0];
    expect(at(SITE_HUD_FRESH_MS - 1).status).toBe("DIRECT");
    expect(at(SITE_HUD_FRESH_MS).status).toBe("LAST KNOWN");
    expect(at(SITE_HUD_FRESH_MS).stale).toBe(true);
    expect(at(SITE_HUD_FRESH_MS).position).not.toBeNull();
    expect(at(SITE_HUD_SIGNAL_LOST_MS - 1).status).toBe("LAST KNOWN");
    expect(at(SITE_HUD_SIGNAL_LOST_MS)).toMatchObject({
      status: "SIGNAL LOST",
      stale: true,
      position: null,
      observedAt,
    });
  });

  it("does not revive an old position merely because the carrier returns", () => {
    const { site, workers } = fixture();
    const view = projectSiteHud(site, workers, {
      nowMs: NOW + SITE_HUD_SIGNAL_LOST_MS,
      connectivity: "ONLINE",
    });
    expect(
      view.crew.every(
        (worker) => worker.status === "SIGNAL LOST" && worker.position === null,
      ),
    ).toBe(true);
    expect(view.anonymousProximity.nearbyCount).toBe(0);
  });

  it("rejects missing, future, non-finite, unknown-floor and invalid-coordinate observations", () => {
    const { workers } = fixture();
    const worker = workers[0];
    const observation = worker.observation!;
    const invalidWorkers: HudWorkerInput[] = [
      { ...worker, observation: null },
      { ...worker, observation: { ...observation, observedAt: -1e100 } },
      { ...worker, observation: { ...observation, observedAt: NOW + 1 } },
      { ...worker, observation: { ...observation, observedAt: Number.NaN } },
      {
        ...worker,
        observation: {
          ...observation,
          position: {
            ...observation.position,
            floorId: "secret-other-site-floor",
          },
        },
      },
      {
        ...worker,
        observation: {
          ...observation,
          position: { ...observation.position, x: Number.POSITIVE_INFINITY },
        },
      },
      {
        ...worker,
        observation: {
          ...observation,
          position: { ...observation.position, y: -1 },
        },
      },
    ];
    const view = project(invalidWorkers);
    expect(
      view.crew.every(
        (member) => member.status === "SIGNAL LOST" && member.position === null,
      ),
    ).toBe(true);
    expect(JSON.stringify(view)).not.toContain("secret-other-site-floor");
    expect(view.crew[1].observedAt).toBeNull();
  });
});

describe("simulated OTG queue and connectivity", () => {
  it("requires explicit matching sync completion, even when no events were queued", () => {
    const offline = connectivityReducer(initialConnectivityState, {
      type: "disconnected",
    });
    expect(offline.mode).toBe("OTG");
    const syncing = connectivityReducer(offline, { type: "reconnected" });
    expect(syncing.mode).toBe("OTG SYNCING");
    expect(connectivityReducer(syncing, { type: "reconnected" })).toBe(syncing);
    expect(
      connectivityReducer(syncing, {
        type: "sync-completed",
        generation: offline.generation,
      }),
    ).toBe(syncing);
    expect(
      connectivityReducer(syncing, {
        type: "sync-completed",
        generation: syncing.generation,
      }).mode,
    ).toBe("ONLINE");
  });

  it("keeps events through flapping and rejects stale completion from an interrupted sync", () => {
    const offline = enqueue(
      connectivityReducer(initialConnectivityState, { type: "disconnected" }),
      "first",
    );
    expect(connectivityReducer(offline, { type: "disconnected" })).toBe(
      offline,
    );
    const firstSync = connectivityReducer(offline, { type: "reconnected" });
    const againOffline = connectivityReducer(firstSync, {
      type: "disconnected",
    });
    expect(
      connectivityReducer(againOffline, {
        type: "sync-completed",
        generation: firstSync.generation,
      }),
    ).toBe(againOffline);
    const secondSync = connectivityReducer(againOffline, {
      type: "reconnected",
    });
    expect(
      connectivityReducer(secondSync, {
        type: "sync-completed",
        generation: firstSync.generation,
      }),
    ).toBe(secondSync);
    expect(secondSync.pendingEvents.map((event) => event.id)).toEqual([
      "first",
    ]);
    const completed = connectivityReducer(secondSync, {
      type: "sync-completed",
      generation: secondSync.generation,
    });
    expect(completed.mode).toBe("ONLINE");
    expect(completed.pendingEvents).toEqual([]);
    expect(
      connectivityReducer(completed, {
        type: "sync-completed",
        generation: secondSync.generation,
      }),
    ).toBe(completed);
  });

  it("preserves events added during sync for a separate explicit completion", () => {
    const offline = enqueue(
      connectivityReducer(initialConnectivityState, { type: "disconnected" }),
      "first",
    );
    const syncing = connectivityReducer(offline, { type: "reconnected" });
    const withNewEvent = enqueue(syncing, "second");
    const nextSync = connectivityReducer(withNewEvent, {
      type: "sync-completed",
      generation: syncing.generation,
    });
    expect(nextSync.mode).toBe("OTG SYNCING");
    expect(nextSync.pendingEvents.map((event) => event.id)).toEqual(["second"]);
    expect(
      connectivityReducer(nextSync, {
        type: "sync-completed",
        generation: syncing.generation,
      }),
    ).toBe(nextSync);
    const complete = connectivityReducer(nextSync, {
      type: "sync-completed",
      generation: nextSync.generation,
    });
    expect(complete.mode).toBe("ONLINE");
    expect(complete.pendingEvents).toEqual([]);
  });

  it("bounds the in-memory queue without silently discarding earlier unacknowledged events", () => {
    let state = connectivityReducer(initialConnectivityState, {
      type: "disconnected",
    });
    for (let index = 0; index < SITE_HUD_QUEUE_LIMIT + 3; index += 1)
      state = enqueue(state, `event-${index}`);
    expect(state.pendingEvents).toHaveLength(SITE_HUD_QUEUE_LIMIT);
    expect(state.pendingEvents[0].id).toBe("event-0");
    expect(state.droppedEvents).toBe(3);
    expect(enqueue(state, "event-0")).toBe(state);
    expect(initialConnectivityState.pendingEvents).toEqual([]);
  });

  it("ignores online, duplicate and malformed local events", () => {
    expect(enqueue(initialConnectivityState, "online")).toBe(
      initialConnectivityState,
    );
    const offline = enqueue(
      connectivityReducer(initialConnectivityState, { type: "disconnected" }),
      "one",
    );
    expect(enqueue(offline, "one")).toBe(offline);
    expect(enqueue(offline, " ")).toBe(offline);
    expect(
      connectivityReducer(offline, {
        type: "local-event",
        id: "invalid-time",
        createdAt: Number.NaN,
      }),
    ).toBe(offline);
  });
});
