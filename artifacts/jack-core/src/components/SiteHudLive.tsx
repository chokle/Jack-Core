import { useEffect, useRef, useState } from "react";
import { SiteRadar } from "./SiteRadar";
import { useRadarAr } from "./useRadarAr";
import "./SiteHud.css";

type LocationState =
  | { kind: "idle" | "loading" | "error"; message?: string }
  | { kind: "located"; latitude: number; longitude: number; accuracy: number };

/** A site has to be explicitly connected before site contacts or landmarks exist. */
export function SiteHudLive({
  expanded = false,
  onOpenRadar,
}: {
  expanded?: boolean;
  onOpenRadar: () => void;
}) {
  const [location, setLocation] = useState<LocationState>({ kind: "idle" });
  const generation = useRef(0);
  const overlayRoot = useRef<HTMLElement>(null);
  const ar = useRadarAr(overlayRoot);
  const [arRange, setArRange] = useState<10 | 50>(10);

  useEffect(() => {
    if (!expanded) ar.clear();
  }, [expanded]);

  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );

  function locate() {
    const request = ++generation.current;
    if (!window.isSecureContext || !navigator.geolocation) {
      setLocation({
        kind: "error",
        message: "Device location is unavailable in this browser.",
      });
      return;
    }
    setLocation({ kind: "loading" });
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        if (request !== generation.current) return;
        if (
          ![coords.latitude, coords.longitude, coords.accuracy].every(
            Number.isFinite,
          )
        ) {
          setLocation({
            kind: "error",
            message: "Device returned an invalid location.",
          });
          return;
        }
        setLocation({
          kind: "located",
          latitude: coords.latitude,
          longitude: coords.longitude,
          accuracy: coords.accuracy,
        });
      },
      (error) => {
        if (request !== generation.current) return;
        setLocation({
          kind: "error",
          message:
            error.code === 1
              ? "Location permission was denied. You can try again after changing browser permissions."
              : "Could not get your location. Try again when the device has a position.",
        });
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    );
  }

  if (!expanded)
    return (
      <div className="site-hud-entry">
        <div>
          <strong>Site radar</strong>
          <span>No site connected</span>
        </div>
        <button type="button" onClick={onOpenRadar}>
          Open radar
        </button>
      </div>
    );

  return (
    <section
      ref={overlayRoot}
      className="site-hud__page"
      aria-label="Site radar"
    >
      <h1>Site radar</h1>
      <p>
        No site connected. Site scans, crew positions, and landmarks will appear
        only after a site is connected.
      </p>
      <SiteRadar
        crew={[]}
        landmarks={[]}
        floorLabel="No site"
        active={ar.state.kind === "running"}
        live
        ar={
          ar.state.kind === "running" || ar.state.kind === "paused"
            ? { ...ar.state, rangeMeters: arRange }
            : undefined
        }
      />
      <div
        className="site-hud-entry site-hud-entry--location site-hud-entry--ar"
        aria-live="polite"
      >
        <div>
          <strong>Phone AR depth</strong>
          {ar.state.kind === "idle" && (
            <span>
              {ar.support === "checking"
                ? "Checking AR support…"
                : ar.support === "unsupported"
                  ? "AR depth is unavailable on this device and browser."
                  : "Scan off"}
            </span>
          )}
          {ar.state.kind === "starting" && (
            <span>Starting camera and depth…</span>
          )}
          {ar.state.kind === "error" && (
            <span role="alert">{ar.state.message}</span>
          )}
          {(ar.state.kind === "running" || ar.state.kind === "paused") && (
            <span>
              {ar.state.kind === "paused"
                ? `Scan stopped · ${ar.state.points.length} measured surfaces held on this phone`
                : !ar.state.pose
                  ? "Waiting for AR tracking…"
                  : !ar.state.depthAvailable
                    ? "Tracking active · waiting for depth. Move phone slowly."
                    : `${ar.state.points.length} measured surfaces · turn the phone to map nearby geometry`}
            </span>
          )}
        </div>
        {ar.state.kind === "running" ? (
          <button type="button" onClick={ar.stop}>
            Stop AR scan
          </button>
        ) : ar.state.kind === "paused" ? (
          <>
            <button type="button" onClick={() => void ar.start()}>
              New AR scan
            </button>
            <button type="button" onClick={ar.clear}>
              Clear scan
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={
              ar.state.kind === "starting" ||
              ar.support === "checking" ||
              ar.support === "unsupported"
            }
            onClick={() => void ar.start()}
          >
            Start AR scan
          </button>
        )}
        {(ar.state.kind === "running" || ar.state.kind === "paused") && (
          <button
            type="button"
            onClick={() => setArRange(arRange === 10 ? 50 : 10)}
          >
            Show {arRange === 10 ? "50 m" : "10 m"} view
          </button>
        )}
      </div>
      <div
        className="site-hud-entry site-hud-entry--location"
        aria-live="polite"
      >
        <div>
          <strong>Your device location</strong>
          {location.kind === "idle" && <span>Location off</span>}
          {location.kind === "loading" && <span>Finding your location…</span>}
          {location.kind === "error" && (
            <span role="alert">{location.message}</span>
          )}
          {location.kind === "located" && (
            <span>
              {location.latitude.toFixed(6)}, {location.longitude.toFixed(6)} ·
              accuracy ±{Math.round(location.accuracy)} m
            </span>
          )}
        </div>
        <button
          type="button"
          disabled={location.kind === "loading"}
          onClick={locate}
        >
          {location.kind === "located" ? "Refresh location" : "Use my location"}
        </button>
      </div>
      {location.kind === "located" && (
        <p>
          <a
            href={`https://www.openstreetmap.org/?mlat=${encodeURIComponent(location.latitude)}&mlon=${encodeURIComponent(location.longitude)}#map=18/${encodeURIComponent(location.latitude)}/${encodeURIComponent(location.longitude)}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open your position on a geographic map
          </a>
        </p>
      )}
      <p>
        Jack does not save or send this location or AR depth. Opening the map
        shares the displayed coordinates with OpenStreetMap. The AR dots are
        surfaces actually measured during this session. Stop holds the scan in
        this page until you clear it or leave. The 10 m and 50 m grids are
        display scales, not detection guarantees or a saved site map.
      </p>
    </section>
  );
}
