// @vitest-environment jsdom
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
        <a>Jack</a><a data-jack-action="up">Welding</a><span aria-current="page">FCAW</span>
      </nav>
      <section role="dialog" aria-label="Node inspector">
        <h2>Wire feed</h2>
        <button data-jack-action="source">Show source</button>
        <div data-node-id="node-42"></div>
      </section>
    `;

    const context = collectJackUiContext();

    expect(context.route).toBe("/app");
    expect(context.surface).toBe("Living Memory");
    expect(context.path).toEqual(["Jack", "Welding", "FCAW"]);
    expect(context.inspector).toEqual({ open: true, label: "Wire feed" });
    expect(context.visibleIds).toContain("node-42");
    expect(context.navigation.canUp).toBe(true);
    expect(context.navigation.hasSourceAction).toBe(true);
    expect(jackUiContextLabel(context)).toBe("Jack › Welding › FCAW");
  });

  it("never forwards raw query or fragment values in the route payload", () => {
    window.history.pushState(
      {},
      "",
      "/app?token=secret-query&view=memory#access_token=secret-fragment",
    );

    const context = collectJackUiContext();
    const decodedHeader = decodeURIComponent(
      encodeJackUiContextHeader(context),
    );

    expect(context.route).toBe("/app");
    expect(decodedHeader).not.toContain("secret-query");
    expect(decodedHeader).not.toContain("secret-fragment");
    expect(decodedHeader).not.toContain("access_token");
  });

  it("drops hidden prior-surface ids, source actions, breadcrumbs and inspectors", () => {
    document.body.innerHTML = `
      <aside><a aria-current="page">Living Memory</a></aside>
      <div style="display:none">
        <nav aria-label="breadcrumb"><a>Old branch</a></nav>
        <section role="dialog" aria-label="Old inspector">
          <button data-jack-action="source">Show source</button>
          <div data-node-id="old-node"></div>
        </section>
      </div>
      <div aria-hidden="true"><div data-entry-id="hidden-entry"></div></div>
      <section><div data-node-id="current-node"></div><button>Inspect</button></section>
    `;

    const context = collectJackUiContext();
    expect(context.visibleIds).toEqual(["current-node"]);
    expect(context.visibleIds).not.toContain("old-node");
    expect(context.visibleIds).not.toContain("hidden-entry");
    expect(context.inspector).toEqual({ open: false, label: null });
    expect(context.navigation.hasSourceAction).toBe(false);
    expect(context.path).toEqual(["Living Memory"]);
  });

  it("replaces stale navigation state when the rendered surface changes", () => {
    document.body.innerHTML = `
      <aside><a aria-current="page">Living Memory</a></aside>
      <section><button data-jack-action="source">Show source</button><div data-node-id="node-old"></div></section>
    `;
    const before = collectJackUiContext();
    expect(before.visibleIds).toContain("node-old");
    expect(before.navigation.hasSourceAction).toBe(true);

    document.body.innerHTML = `
      <aside><a aria-current="page">Library</a></aside>
      <section style="display:none"><button data-jack-action="source">Show source</button><div data-node-id="node-old"></div></section>
      <section><div data-entry-id="entry-new"></div></section>
    `;
    const after = collectJackUiContext();
    expect(after.surface).toBe("Library");
    expect(after.visibleIds).toEqual(["entry-new"]);
    expect(after.navigation.hasSourceAction).toBe(false);
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
