# Site HUD and OTG

Architecture and first milestone for [issue #126](https://github.com/chokle/Jack-Core/issues/126), reviewed 2026-09-05.

## First milestone

The deliverable is a deterministic, fictional site instrument for reviewing the interaction and state model. A compact, theme-matched status bar persists across authenticated Jack surfaces. The Site radar navigation item opens a dedicated page on desktop and mobile; floor/elevation, crew, safety-landmark and alert details appear inline on that page. This milestone does not establish field positioning, emergency coverage or production readiness.

Entry requires `VITE_SITE_HUD_DEMO_ENABLED === "true"` (unset is disabled), a resolved signed-in account, and an explicit **Open demo site** action. The fictional site is not inferred from the account, its pilot membership or location. Closing the demo or leaving the authenticated account boundary discards its state.

Production builds read the GitHub repository variable `VITE_SITE_HUD_DEMO_ENABLED` through the matching Docker build argument. It defaults to `false`; setting it to `true` and deploying exposes only the explicit fictional demo entry to signed-in accounts. Setting it back to `false` and redeploying removes the entry. This build flag never enables real tracking or radio transport.

All workers, contractor scopes, floor coordinates and landmarks are fixtures. Site HUD adds no location collection, real worker identity ingestion, radio discovery, network transport, telemetry or persistent storage. Existing application authentication remains responsible for the signed-in entry check. Opening the demo does not opt a user into tracking or site membership.

## Radar presentation and compass

The instrument uses a black background. A persistent floor/elevation view sits beside the radar on desktop and directly below it on mobile. It renders a simulated structural skeleton with selectable floor planes, frame columns and retained crew markers. Pointer, Enter and Space select floors. Its floor selection, retained-position counts and selected-floor roster use the same scoped projection as the radar; elevations are fixture plan values, not sensed altitude. Frame geometry is illustrative, not a surveyed building model or measured structural layout.

The radar uses the same fixture projection and connectivity state as the persistent HUD. Navigating between pages retains the open demo and manual heading; closing the demo or changing accounts resets them. No separate Command Centre state or backend event system is introduced by this presentation change.

A four-second visual sweep illuminates fresh plotted contacts as it crosses their bearing. Stale contacts remain visibly stale; animation never refreshes an observation timestamp. Reduced-motion preferences disable the animated sweep. The sweep is a visual simulation, not an active radio scan.

North and the fictional world rotate opposite the selected heading while the viewer marker stays fixed. Manual heading is always available. **Use device compass** explicitly enables supported browser orientation readings and requests permission where required. Relative, invalid, excessively tilted, inaccurate or expired readings fall back to manual heading. Leaving the radar page removes sensor listeners and stops animation; returning requires explicitly enabling the device compass again. Device readings are a magnetic/absolute reference, not verified true north. They remain local and are not stored or transmitted. Physical-device acceptance remains required.

The separate **Nearby signals** area performs no scan. Future unlocated device observations must remain separate from plotted crew: receiving an advertisement does not establish a person, direction, distance or floor. An empty view does not establish that an area is clear.

## State and visibility contract

[`site-hud.ts`](../artifacts/jack-core/src/lib/site-hud.ts) owns pure projection, fixtures and the connectivity reducer. The UI renders their output and sends explicit simulation actions. Position coordinates are percentages on a fictional plan, not measured distance or accuracy. Floor elevations describe the fixture building, not a sensed worker elevation.

Each visible worker position includes its observation timestamp, source and confidence state. Demo freshness thresholds are 15 seconds and 120 seconds; they are review fixtures, not validated field operating limits.

| State         | Meaning in the simulation                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `LIVE`        | Fresh cloud-source observation while simulated mode is `ONLINE`.                                                                                             |
| `DIRECT`      | Fresh local-direct observation. Carrier loss alone does not erase it.                                                                                        |
| `RELAYED`     | Fresh local-relay observation; source remains visibly relayed.                                                                                               |
| `LAST KNOWN`  | Observation is at least 15 seconds old, or cloud-source while outside `ONLINE`. It may no longer describe the worker's location.                             |
| `SIGNAL LOST` | At least 120 seconds old, missing/invalid observation, future timestamp, invalid source, or invalid floor/coordinates. Current plotted position is withheld. |

The viewer must have an explicit valid fixture contractor scope. Same-site workers in explicitly authorized contractors may expose identity and position. Outside that scope, only a fresh nearby aggregate count is projected: no names, worker IDs, trades, floor or coordinates. Wrong-site and missing-contractor records are excluded; invalid viewer scope produces no crew or anonymous count.

**This browser projection is not an authorization boundary.** Before real data enters the browser, the API must resolve the authenticated subject, current site membership and explicit contractor/team grants, then filter identity/location server-side. Anonymous proximity also needs its own approved policy; small counts can disclose presence. The real observation contract must define source provenance, capture time, expiry and uncertainty, with explicit handling for clock skew and unsupported measurements. Names, trades or proximity cannot establish authorization.

## OTG and reconciliation

`ONLINE` uses cyan/blue; `OTG` and `OTG SYNCING` use amber/orange throughout the instrument. Local-link imagery describes the simulated mode, not a detected mesh.

1. Simulated loss: `ONLINE` → `OTG`; cloud observations become last known while fresh local fixture observations retain direct/relayed status.
2. Simulated recovery: `OTG` → `OTG SYNCING`; reconnection alone does not clear pending events.
3. Explicit demo reconciliation acknowledges the captured event batch. Events added during reconciliation remain pending for a subsequent batch. Only an empty queue returns to `ONLINE`.
4. Another disconnect invalidates the prior reconciliation generation; a late completion cannot overwrite the newer OTG state.

The queue holds at most 20 events in memory. Pending duplicate IDs are ignored; overflow increments a visible dropped-event count without discarding older pending events. Reconciliation is a local demonstration, not a server sync, durable receipt or proof of delivery. Refresh/reset destroys the queue; it must never hold real safety reports.

Browser `online`/`offline` signals are hints only. `navigator.onLine` uses OS/browser heuristics and may report a connected LAN with no Internet access. A future transport must establish Jack service reachability and authenticated acknowledgement separately before declaring real synchronization complete. [MDN: Navigator.onLine](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/onLine)

## Browser and hardware boundary

These are capability constraints, not hardware commitments or promised field coverage.

| Capability             | Verified platform boundary and design consequence                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser BLE            | Web Bluetooth requires a secure context and a user gesture/device chooser. Its central-role API connects to peripheral GATT servers; it does not provide an arbitrary phone-to-phone mesh. Support is limited across browsers, so feature detection and a supported-device plan are required. [Chrome implementation documentation](https://developer.chrome.com/docs/capabilities/bluetooth), [MDN availability](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API). |
| Apple ranging          | Nearby Interaction is a native framework for compatible UWB devices/accessories; capability, session setup and permissions must be checked. It is not a universal phone feature. [Apple Nearby Interaction](https://developer.apple.com/documentation/nearbyinteraction).                                                                                                                                                                                                              |
| Android ranging        | Android documents UWB through Jetpack, supported UWB hardware, permissions and an out-of-band exchange for ranging setup. Device support and session lifecycle must be tested. [Android UWB](https://developer.android.com/develop/connectivity/uwb).                                                                                                                                                                                                                                  |
| Cross-platform ranging | Architectural conclusion from the Apple/Android platform contracts above: this browser milestone cannot promise universal UWB ranging. Native adapters and a tested hardware matrix are prerequisites for any later precision feature.                                                                                                                                                                                                                                                 |
| LoRa/site radio        | A LoRaWAN installation uses radio end devices, gateways and network/application servers. A dedicated site gateway is the proposed integration boundary; no browser/phone LoRa radio is assumed. LoRaWAN is not the same thing as a generic peer mesh. [LoRa Alliance architecture](https://lora-alliance.org/about-lorawan/).                                                                                                                                                          |

## Subsequent phases

**Phase 1 — approved software baseline:** after site authorization, permission, consent and retention decisions, add offline access to authorized safety landmarks and approved critical knowledge. Define per-site cache expiry, version/provenance, logout/account-switch clearing, revocation behavior and stale-data presentation before storing real data. Add bounded durable event handling, idempotent server receipts and failure/retry reconciliation separately. Current fixtures and queue are memory-only; cached authorized data is future work.

**Phase 2 — supported local proximity:** choose a native/device protocol for discovery, authenticated peer identity, direct/relayed provenance, replay protection and withdrawal. Validate foreground/background restrictions, battery use, disconnections and relay behavior on actual devices. Keep carrier loss separate from loss of all local observations. A BLE connection or RSSI value alone does not establish an exact indoor location; uncertainty must remain explicit.

**Phase 3 — ranging and site anchors:** evaluate compatible UWB devices, fixed floor/shaft/exit/muster anchors and any dedicated BLE/LoRa gateway. Site calibration and observed failures around concrete, steel, shafts, underground areas and interference must inform confidence. Never promote an unmeasured or stale position to precise current coordinates or imply guaranteed rescue.

Radio Jack integration remains future work on an authorized, filtered HUD view. Answers about a worker, floor or muster point must retain timestamp/source/confidence and distinguish last known or relayed data. The simulation supplies no production chat context and does not modify the Jack Everywhere implementation.

## Acceptance and release

Milestone verification must cover default-disabled entry, resolved authentication and explicit fictional-site activation; desktop/mobile expansion; cyan/amber states; observation expiry and missing/future data; contractor projection without outside identities or coordinates; bounded queues, duplicates, overflow and interrupted reconciliation; and applicable frontend tests, typecheck, build and formatting. A browser check must confirm the rendered interaction and clear simulation labels. Record actual results in the implementation handoff rather than treating this contract as evidence of passing checks.

Derek explicitly authorized proceeding with this first milestone after the voice acceptance update, overriding the earlier sequencing hold. This permits the fictional demo release; it does not establish acceptance of the remaining #112 navigation work or telemetry, or authorize real tracking and later hardware phases. Release verification must establish the exact deployed revision and flag state, then verify the explicit demo on desktop and mobile. Keep later real-data, caching and radio milestones open.

### Selected HUD design

The user-supplied JACK SITE HUD image is the accepted visual target. The elevation panel depicts an illustrative structural frame, not stacked list cards. Safety landmarks use distinct, shared icons for muster, fire exit, fire extinguisher, first aid, air horn, entry and hazard in both the radar and legend. A fictional ground-floor extinguisher is included. Unknown landmark kinds use a generic marker rather than breaking the HUD. Compass settings expand from a compact control without activating device sensors on their own. No live building survey, scanning or structural accuracy is implied.
