import { beforeEach, describe, expect, it } from "vitest";
import {
  collectJackUiContext,
  encodeJackUiContextHeader,
  jackUiContextLabel,
} from "./jack-ui-context";

beforeEach(() => {
  document.body.innerHTML = "";
  document.title = "Jack";
  window.history.replaceState({}, "", "/app");
});

describe("Jack UI context", () => {
  it("captures route, active surface, breadcrumb path, inspector and visible ids", () => {
    window.history.pushState({}, "", "/app?view=memory#node");
    document.body.innerHTML = `
      <aside><a aria-current="page">Living Memory</a></aside>
      <nav aria-label="breadcrumb">
        <a>Jack</a><a>Welding</a><span aria-current="page">FCAW</span>
      </nav>
      <section role="dialog" aria-label="Node inspector">
        <h2>Wire feed</h2>
        <button>Show source</button>
        <div data-node-id="node-42"></div>
      </section>
    `;

    const context = collectJackUiContext();

    expect(context.route).toBe("/app?view=memory#node");
    expect(context.surface).toBe("Living Memory");
    expect(context.path).toEqual(["Jack", "Welding", "FCAW"]);
    expect(context.inspector).toEqual({ open: true, label: "Wire feed" });
    expect(context.visibleIds).toContain("node-42");
    expect(context.navigation.canUp).toBe(true);
    expect(context.navigation.hasSourceAction).toBe(true);
    expect(jackUiContextLabel(context)).toBe("Jack › Welding › FCAW");
  });

  it("bounds the encoded header even with many visible ids", () => {
    document.body.innerHTML = Array.from(
      { length: 80 },
      (_, i) => `<div data-record-id="record-${i}-${"x".repeat(100)}"></div>`,
    ).join("");

    const header = encodeJackUiContextHeader(collectJackUiContext());
    expect(header.length).toBeLessThanOrEqual(3500);
    expect(decodeURIComponent(header)).toContain('"version":1');
  });
});
