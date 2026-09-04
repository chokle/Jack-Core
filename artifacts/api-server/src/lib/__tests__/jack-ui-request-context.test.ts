import { describe, expect, it } from "vitest";
import {
  formatJackUiContextForModel,
  parseJackUiContextHeader,
} from "../jack-ui-request-context.js";

function encoded(overrides: Record<string, unknown> = {}) {
  return encodeURIComponent(
    JSON.stringify({
      version: 1,
      route: "/app?view=memory",
      surface: "Living Memory",
      path: ["Jack", "Welding", "FCAW"],
      inspector: { open: true, label: "Wire feed" },
      visibleIds: ["node-42"],
      navigation: { canBack: true, canUp: true, hasSourceAction: true },
      capturedAt: "2026-09-04T22:00:00.000Z",
      ...overrides,
    }),
  );
}

const NOW = Date.parse("2026-09-04T22:00:05.000Z");

describe("Jack UI request context", () => {
  it("accepts a fresh bounded Jack-app packet", () => {
    const context = parseJackUiContextHeader(encoded(), NOW);
    expect(context).toMatchObject({
      route: "/app?view=memory",
      surface: "Living Memory",
      path: ["Jack", "Welding", "FCAW"],
      inspector: { open: true, label: "Wire feed" },
      visibleIds: ["node-42"],
      navigation: { canBack: true, canUp: true, hasSourceAction: true },
    });
  });

  it("rejects malformed, oversized, stale, and future packets", () => {
    expect(parseJackUiContextHeader("%7Bbad", NOW)).toBeNull();
    expect(parseJackUiContextHeader("x".repeat(3501), NOW)).toBeNull();
    expect(
      parseJackUiContextHeader(
        encoded({ capturedAt: "2026-09-04T21:59:00.000Z" }),
        NOW,
      ),
    ).toBeNull();
    expect(
      parseJackUiContextHeader(
        encoded({ capturedAt: "2026-09-04T22:00:20.000Z" }),
        NOW,
      ),
    ).toBeNull();
  });

  it("frames context as UI-only and preserves no-invented-context boundaries", () => {
    const context = parseJackUiContextHeader(encoded(), NOW);
    expect(context).not.toBeNull();
    const prompt = formatJackUiContextForModel(context!);
    expect(prompt).toContain("CURRENT JACK APPLICATION UI CONTEXT");
    expect(prompt).toContain("path: Jack > Welding > FCAW");
    expect(prompt).toContain("go back");
    expect(prompt).toContain("Do NOT treat UI state as evidence of welding process");
    expect(prompt).toContain("no-invented-context rules outrank this UI context");
  });
});
