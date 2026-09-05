import { describe, expect, it } from "vitest";
import type { Request, Response } from "express";
import {
  currentJackUiRequestContext,
  formatJackUiContextForModel,
  jackUiRequestContextMiddleware,
  parseJackUiContextHeader,
} from "../jack-ui-request-context.js";

function encoded(overrides: Record<string, unknown> = {}) {
  return encodeURIComponent(
    JSON.stringify({
      version: 1,
      route: "/app",
      surface: "Living Memory",
      path: ["Jack", "Welding", "FCAW"],
      inspector: { open: true, label: "Wire feed" },
      visibleIds: ["node-42"],
      navigation: {
        canBack: true,
        canUp: true,
        canForward: true,
        hasSourceAction: true,
      },
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
      route: "/app",
      surface: "Living Memory",
      path: ["Jack", "Welding", "FCAW"],
      inspector: { open: true, label: "Wire feed" },
      visibleIds: ["node-42"],
      navigation: {
        canBack: true,
        canUp: true,
        canForward: true,
        hasSourceAction: true,
      },
    });
  });

  it("rejects malformed, oversized, stale, and future packets", () => {
    expect(parseJackUiContextHeader("%7Bbad", NOW)).toBeNull();
    expect(parseJackUiContextHeader("x".repeat(3501), NOW)).toBeNull();
    expect(
      parseJackUiContextHeader(
        encoded({
          navigation: {
            canBack: true,
            canUp: true,
            canForward: "yes",
            hasSourceAction: true,
          },
        }),
        NOW,
      ),
    ).toBeNull();
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

  it("defaults the forward affordance for an older v1 packet", () => {
    const context = parseJackUiContextHeader(
      encoded({
        navigation: { canBack: true, canUp: true, hasSourceAction: true },
      }),
      NOW,
    );
    expect(context?.navigation.canForward).toBe(false);
  });

  it("rejects client-supplied query, fragment, absolute, and network-path route values", () => {
    expect(
      parseJackUiContextHeader(encoded({ route: "/app?token=secret" }), NOW),
    ).toBeNull();
    expect(
      parseJackUiContextHeader(
        encoded({ route: "/app#access_token=secret" }),
        NOW,
      ),
    ).toBeNull();
    expect(
      parseJackUiContextHeader(
        encoded({ route: "https://jack.torchlabs.ca/app" }),
        NOW,
      ),
    ).toBeNull();
    expect(
      parseJackUiContextHeader(
        encoded({ route: "//external.example/path" }),
        NOW,
      ),
    ).toBeNull();
  });

  it("serializes validated context as delimited untrusted data", () => {
    const context = parseJackUiContextHeader(encoded(), NOW);
    expect(context).not.toBeNull();
    const prompt = formatJackUiContextForModel(context!);
    expect(prompt).toContain("UNTRUSTED JACK APPLICATION UI STATE DATA");
    expect(prompt).toContain("BEGIN_JACK_UI_CONTEXT_DATA");
    expect(prompt).toContain('"path":["Jack","Welding","FCAW"]');
    expect(prompt).toContain('"visibleIds":["node-42"]');
    expect(prompt).toContain("END_JACK_UI_CONTEXT_DATA");
  });

  it("isolates concurrent request-local packets", async () => {
    const run = (surface: string, delayMs: number) =>
      new Promise<string | null>((resolve) => {
        const req = {
          get: () =>
            encodeURIComponent(
              JSON.stringify({
                version: 1,
                route: "/app",
                surface,
                path: [surface],
                inspector: { open: false, label: null },
                visibleIds: [],
                navigation: {
                  canBack: false,
                  canUp: false,
                  canForward: false,
                  hasSourceAction: false,
                },
                capturedAt: new Date().toISOString(),
              }),
            ),
        } as unknown as Request;

        jackUiRequestContextMiddleware(req, {} as Response, () => {
          setTimeout(
            () => resolve(currentJackUiRequestContext()?.surface ?? null),
            delayMs,
          );
        });
      });

    await expect(
      Promise.all([run("Living Memory", 5), run("Library", 0)]),
    ).resolves.toEqual(["Living Memory", "Library"]);
  });
});
