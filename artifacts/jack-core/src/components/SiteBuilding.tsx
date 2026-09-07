import type { HudCrewMember, HudFloor } from "../lib/site-hud";
import "./SiteBuilding.css";

interface Props {
  floors: readonly HudFloor[];
  crew: readonly HudCrewMember[];
  selectedFloor?: string;
  onSelectFloor: (id: string) => void;
}

/** Fictional framing diagram. Geometry is illustrative, never a surveyed model. */
export function SiteBuilding({
  floors,
  crew,
  selectedFloor,
  onSelectFloor,
}: Props) {
  const ordered = [...floors].sort(
    (a, b) => b.elevationMeters - a.elevationMeters,
  );
  const height = Math.max(240, ordered.length * 80 + 100);
  const base = height - 42;
  const roof = 50;
  const plane = (y: number) => `70,${y} 210,${y} 248,${y - 28} 108,${y - 28}`;
  return (
    <div className="site-building">
      <svg
        viewBox={`0 0 300 ${height}`}
        role="group"
        aria-label="Simulated building skeleton"
      >
        <g className="site-building__frame" aria-hidden="true">
          <polygon points={plane(roof)} />
          <polygon points={plane(base)} />
          {[70, 105, 140, 175, 210].map((x) => (
            <path
              key={x}
              d={`M${x} ${roof}V${base}M${x + 38} ${roof - 28}V${base - 28}M${x} ${roof}l38 -28`}
            />
          ))}
          <path
            d={`M140 ${roof}V${base}M158 ${roof}V${base}M140 ${roof}l18 0M70 ${base}H260`}
          />
        </g>
        {ordered.map((floor, index) => {
          const y = roof + 65 + index * 80;
          const positions = crew.filter(
            (member) => member.position?.floorId === floor.id,
          );
          return (
            <g
              key={floor.id}
              role="button"
              tabIndex={0}
              aria-label={`View ${floor.label}`}
              aria-pressed={selectedFloor === floor.id}
              className="site-building__floor"
              onClick={() => onSelectFloor(floor.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelectFloor(floor.id);
                }
              }}
            >
              <title>
                {floor.label}, plan elevation {floor.elevationMeters} m,{" "}
                {positions.length} retained positions
              </title>
              <polygon
                className="site-building__hit"
                points={`4,${y - 50} 286,${y - 50} 286,${y + 18} 4,${y + 18}`}
              />
              <polygon className="site-building__slab" points={plane(y)} />
              <path
                className="site-building__beam"
                d={`M70 ${y + 4}H210l38 -28M70 ${y}l140 -65M210 ${y}l38 -93M140 ${y}l18 -65`}
              />
              <text className="site-building__label" x="4" y={y - 12}>
                {floor.label}
              </text>
              <text className="site-building__elevation" x="4" y={y + 2}>
                {floor.elevationMeters} m
              </text>
              <text
                className="site-building__count"
                x="275"
                y={y - 12}
                textAnchor="end"
              >
                {positions.length}
              </text>
              {positions.map((member) => {
                const position = member.position!;
                // Existing fictional plan coordinates projected onto an illustrative floor plane.
                const x = 75 + position.x * 1.25 + (100 - position.y) * 0.3;
                const cy = y - (100 - position.y) * 0.25 - 6;
                return (
                  <circle
                    key={member.id}
                    className="site-building__contact"
                    data-stale={member.stale}
                    cx={x}
                    cy={cy}
                    r="4"
                    aria-hidden="true"
                  >
                    <title>
                      {member.name} · {member.status}
                    </title>
                  </circle>
                );
              })}
            </g>
          );
        })}
      </svg>
      <p>Simulated structural frame · Not a building survey</p>
    </div>
  );
}
