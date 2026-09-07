import { useState } from "react";
import { createSiteHudFixture } from "../lib/site-hud";
import { SiteHud } from "./SiteHud";

/** Explicit fictional site context. Never infer a worker's site from their account. */
export function SiteHudDemo({
  expanded = false,
  onOpenRadar,
  onExitRadar,
}: {
  expanded?: boolean;
  onOpenRadar: () => void;
  onExitRadar: () => void;
}) {
  const [fixture, setFixture] = useState<ReturnType<
    typeof createSiteHudFixture
  > | null>(null);

  if (!fixture) {
    return (
      <div
        className={
          expanded ? "site-hud-entry site-hud-entry--page" : "site-hud-entry"
        }
      >
        <div>
          <strong>Site radar</strong>
          <span>Fictional site · Demo only</span>
        </div>
        {expanded && (
          <p>
            A full view of demo crew, site landmarks and signal conditions. Turn
            the heading control to explore the radar. No nearby devices are
            scanned.
          </p>
        )}
        <button
          type="button"
          onClick={() => {
            setFixture(createSiteHudFixture(Date.now()));
            onOpenRadar();
          }}
        >
          Open demo site
        </button>
      </div>
    );
  }

  return (
    <SiteHud
      site={fixture.site}
      workers={fixture.workers}
      expanded={expanded}
      onOpenRadar={onOpenRadar}
      onCloseDemo={() => {
        setFixture(null);
        if (expanded) onExitRadar();
      }}
    />
  );
}
