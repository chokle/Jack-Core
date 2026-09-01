import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("pilot-primary closeout architecture", () => {
  const source = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");

  it("does not gate participant Closeout on telemetry bootstrap", () => {
    expect(source).toContain("const canViewCloseout = me?.isAdmin === false;");
    expect(source).not.toContain("!!ownedTelemetryContext?.scope?.pilotId");
    expect(source).toContain('view === "closeout" && canViewCloseout');
  });

  it("does not pass telemetry-derived scope into Closeout", () => {
    const start = source.indexOf("<EndOfShiftCloseout");
    const end = source.indexOf("/>", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const closeoutBlock = source.slice(start, end);
    expect(closeoutBlock).not.toContain("ownedTelemetryContext");
    expect(closeoutBlock).toContain("participantId");
  });
});
