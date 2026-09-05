import { useState } from "react";
import { createSiteHudFixture } from "../lib/site-hud";
import { SiteHud } from "./SiteHud";

/** Explicit fictional site context. Never infer a worker's site from their account. */
export function SiteHudDemo() {
  const [fixture, setFixture] = useState<ReturnType<
    typeof createSiteHudFixture
  > | null>(null);

  if (!fixture) {
    return (
      <button
        type="button"
        onClick={() => setFixture(createSiteHudFixture(Date.now()))}
        className="rounded-lg border border-cyan-700 bg-slate-950 px-3 py-2 text-xs font-medium text-cyan-200"
      >
        Open demo site
      </button>
    );
  }

  return (
    <div className="w-fit max-w-full">
      <SiteHud site={fixture.site} workers={fixture.workers} />
      <button
        type="button"
        onClick={() => setFixture(null)}
        className="mt-1 rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
      >
        Close demo site
      </button>
    </div>
  );
}
