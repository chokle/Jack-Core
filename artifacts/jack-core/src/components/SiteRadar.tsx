import { useEffect, useId, useRef, useState } from "react";
import type { HudCrewMember, HudLandmark } from "../lib/site-hud";
import {
  compassHeading,
  contactIllumination,
  radarBearing,
} from "../lib/radar-heading";
import "./SiteRadar.css";

const SWEEP_PERIOD_MS = 4000;

interface Props {
  crew: readonly HudCrewMember[];
  landmarks: readonly HudLandmark[];
  floorLabel: string;
  describeMember?: (member: HudCrewMember) => string;
  active?: boolean;
}

export function SiteRadar({
  crew,
  landmarks,
  floorLabel,
  describeMember,
  active = true,
}: Props) {
  const id = useId();
  const [manualHeading, setManualHeading] = useState(0);
  const [deviceHeading, setDeviceHeading] = useState<number | null>(null);
  const [deviceEnabled, setDeviceEnabled] = useState(false);
  const [message, setMessage] = useState("Manual demo heading");
  const [sweep, setSweep] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);
  const permissionGeneration = useRef(0);
  const heading = deviceHeading ?? manualHeading;

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(media?.matches ?? false);
    update();
    media?.addEventListener("change", update);
    return () => media?.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!active || reducedMotion) return;
    let frame = 0;
    let previous = 0;
    const tick = (now: number) => {
      if (now - previous >= 32) {
        setSweep(((now % SWEEP_PERIOD_MS) / SWEEP_PERIOD_MS) * 360);
        previous = now;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active, reducedMotion]);

  useEffect(() => {
    if (!active) {
      permissionGeneration.current++;
      setDeviceEnabled(false);
      setDeviceHeading(null);
      setMessage("Manual demo heading");
    }
    return () => {
      permissionGeneration.current++;
    };
  }, [active]);

  useEffect(() => {
    if (!active || !deviceEnabled) return;
    let timeout: ReturnType<typeof setTimeout>;
    const expire = () => {
      setDeviceHeading(null);
      setMessage("Compass unavailable or stale · using manual heading");
    };
    const receive = (raw: Event) => {
      const orientation = raw as DeviceOrientationEvent & {
        webkitCompassHeading?: number;
      };
      // Browsers can emit relative and absolute events together. A relative
      // sample must not replace a valid earth-referenced heading.
      if (
        !orientation.absolute &&
        orientation.webkitCompassHeading === undefined
      )
        return;
      const reading = compassHeading(
        orientation,
        window.screen.orientation?.angle ?? 0,
      );
      if (reading === null) {
        setDeviceHeading(null);
        setMessage("Hold the device flat · using manual heading");
        return;
      }
      setDeviceHeading(reading);
      setMessage(
        "Device compass · magnetic/absolute reference, not verified true north",
      );
      clearTimeout(timeout);
      timeout = setTimeout(expire, 3000);
    };
    timeout = setTimeout(expire, 3000);
    window.addEventListener("deviceorientationabsolute", receive);
    window.addEventListener("deviceorientation", receive);
    return () => {
      clearTimeout(timeout);
      window.removeEventListener("deviceorientationabsolute", receive);
      window.removeEventListener("deviceorientation", receive);
    };
  }, [active, deviceEnabled]);

  async function enableCompass() {
    if (!active) return;
    const generation = ++permissionGeneration.current;
    const constructor =
      window.DeviceOrientationEvent as typeof DeviceOrientationEvent & {
        requestPermission?: (absolute?: boolean) => Promise<string>;
      };
    if (!window.isSecureContext || !constructor) {
      setMessage("Device compass unavailable · using manual heading");
      return;
    }
    try {
      const result = constructor.requestPermission
        ? await constructor.requestPermission(true)
        : "granted";
      if (generation !== permissionGeneration.current) return;
      if (result !== "granted") {
        setMessage("Compass permission denied · using manual heading");
        return;
      }
      setDeviceEnabled(true);
      setMessage("Waiting for compass · hold the device flat");
    } catch {
      if (generation === permissionGeneration.current)
        setMessage("Compass unavailable · using manual heading");
    }
  }

  return (
    <section className="site-radar" aria-label="Site radar">
      <div className="site-radar__readout">
        <span>{floorLabel}</span>
        <strong>{Math.round(heading).toString().padStart(3, "0")}°</strong>
        <span>4 SEC SWEEP · DEMO</span>
      </div>
      <svg
        className="site-radar__scope"
        viewBox="0 0 400 400"
        role="group"
        aria-label={`Schematic radar: ${floorLabel}. Not for navigation.`}
      >
        <defs>
          <radialGradient id={`${id}-glow`}>
            <stop
              offset="0"
              stopColor="var(--hud-accent, #67e8f9)"
              stopOpacity=".09"
            />
            <stop
              offset="1"
              stopColor="var(--hud-accent, #67e8f9)"
              stopOpacity=".015"
            />
          </radialGradient>
        </defs>
        <circle cx="200" cy="200" r="165" fill={`url(#${id}-glow)`} />
        {[27.5, 55, 82.5, 110, 137.5, 165].map((r) => (
          <circle
            key={r}
            cx="200"
            cy="200"
            r={r}
            className="site-radar__grid"
          />
        ))}
        <path d="M200 35V365M35 200H365" className="site-radar__grid" />
        <g data-testid="radar-world" transform={`rotate(${-heading} 200 200)`}>
          {Array.from({ length: 72 }, (_, index) => (
            <path
              key={index}
              d={`M200 35V${index % 6 === 0 ? 44 : 39}`}
              transform={`rotate(${index * 5} 200 200)`}
              className="site-radar__tick"
            />
          ))}
          {Array.from({ length: 12 }, (_, index) => {
            const degrees = index * 30;
            const angle = (degrees * Math.PI) / 180;
            const x = 200 + Math.sin(angle) * 150;
            const y = 200 - Math.cos(angle) * 150;
            return (
              <text
                key={`bearing-${degrees}`}
                x={x}
                y={y}
                transform={`rotate(${heading} ${x} ${y})`}
                className="site-radar__bearing"
                textAnchor="middle"
                dominantBaseline="middle"
              >
                {degrees}
              </text>
            );
          })}
          {(
            [
              ["N", 200, 20],
              ["E", 382, 204],
              ["S", 200, 387],
              ["W", 18, 204],
            ] as const
          ).map(([label, x, y]) => (
            <text
              key={label}
              x={x}
              y={y}
              textAnchor="middle"
              transform={`rotate(${heading} ${x} ${y})`}
              className={
                label === "N" ? "site-radar__north" : "site-radar__cardinal"
              }
            >
              {label}
            </text>
          ))}
          {landmarks.map((point) => {
            const x = 200 + (point.x - 50) * 2.2,
              y = 200 + (point.y - 50) * 2.2;
            return (
              <g
                key={point.id}
                role="img"
                aria-label={`${point.label}, ${point.kind}`}
              >
                <title>{point.label}</title>
                <path
                  d={`M${x} ${y - 5}l5 5-5 5-5-5Z`}
                  className="site-radar__landmark"
                />
              </g>
            );
          })}
          {crew
            .filter((member) => member.position !== null)
            .map((member) => {
              const position = member.position!;
              const x = 200 + (position.x - 50) * 2.2,
                y = 200 + (position.y - 50) * 2.2;
              const illumination = reducedMotion
                ? 1
                : contactIllumination(
                    radarBearing(position.x, position.y),
                    heading,
                    sweep,
                  );
              return (
                <g
                  key={member.id}
                  role="img"
                  aria-label={
                    describeMember?.(member) ??
                    `${member.name}, ${member.status}`
                  }
                  className={
                    member.stale
                      ? "site-radar__contact site-radar__contact--stale"
                      : "site-radar__contact"
                  }
                >
                  <title>
                    {member.name} · {member.status}
                  </title>
                  {!member.stale && (
                    <circle
                      cx={x}
                      cy={y}
                      r={5 + 7 * illumination}
                      opacity={illumination * 0.5}
                      className="site-radar__ping"
                    />
                  )}
                  <circle
                    cx={x}
                    cy={y}
                    r="4.5"
                    opacity={member.stale ? 0.7 : illumination}
                  />
                  <text
                    x={x}
                    y={y + 17}
                    transform={`rotate(${heading} ${x} ${y})`}
                  >
                    {member.name.split(" ")[0]}
                  </text>
                </g>
              );
            })}
        </g>
        {!reducedMotion && (
          <g
            data-testid="radar-sweep"
            transform={`rotate(${sweep} 200 200)`}
            aria-hidden="true"
          >
            <path
              d="M200 200L117.5 57.1A165 165 0 0 1 200 35Z"
              fill="var(--hud-accent, #67e8f9)"
              opacity=".14"
            />
            <path
              d="M200 200V35"
              stroke="var(--hud-accent, #67e8f9)"
              strokeWidth="1.8"
              opacity=".8"
            />
          </g>
        )}
        <path
          d="M200 187L208 207L200 202L192 207Z"
          className="site-radar__viewer"
        >
          <title>You · facing forward</title>
        </path>
      </svg>
      <div className="site-radar__legend">
        <span>● Crew</span>
        <span>◇ Site landmark</span>
        <span>◌ Last known</span>
      </div>
      <div className="site-radar__controls">
        <label htmlFor={`${id}-heading`}>
          Turn demo heading <output>{manualHeading}°</output>
        </label>
        <input
          id={`${id}-heading`}
          type="range"
          min="0"
          max="359"
          value={manualHeading}
          onChange={(event) => {
            permissionGeneration.current++;
            setDeviceEnabled(false);
            setDeviceHeading(null);
            setMessage("Manual demo heading");
            setManualHeading(Number(event.target.value));
          }}
        />
        <button
          type="button"
          onClick={() => {
            if (deviceEnabled) {
              permissionGeneration.current++;
              setDeviceEnabled(false);
              setDeviceHeading(null);
              setMessage("Manual demo heading");
            } else void enableCompass();
          }}
        >
          {deviceEnabled ? "Use manual heading" : "Use device compass"}
        </button>
        <p aria-live="polite">{message}</p>
      </div>
      <p className="site-radar__notice">
        Fictional positions · sweep is a visual simulation, not nearby
        detection. N is demo north in manual mode. Not for navigation.
      </p>
    </section>
  );
}
