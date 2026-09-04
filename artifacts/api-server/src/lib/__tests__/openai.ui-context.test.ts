import { describe, expect, it } from "vitest";
import type { Request, Response } from "express";
import { jackUiRequestContextMiddleware } from "../jack-ui-request-context.js";
import { withJackUiRequestContext } from "../openai.js";

function freshHeader() {
  return encodeURIComponent(
    JSON.stringify({
      version: 1,
      route: "/app?view=memory",
      surface: "Living Memory",
      path: ["Jack", "Welding", "FCAW"],
      inspector: { open: true, label: "Wire feed" },
      visibleIds: ["node-42"],
      navigation: { canBack: true, canUp: true, hasSourceAction: true },
      capturedAt: new Date().toISOString(),
    }),
  );
}

describe("chat inference Jack UI context", () => {
  it("injects valid request-local UI state after the primary system message", () => {
    const req = {
      get: (name: string) => (name === "X-Jack-Context" ? freshHeader() : undefined),
    } as Request;

    jackUiRequestContextMiddleware(req, {} as Response, () => {
      const params = withJackUiRequestContext({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Primary Jack safety prompt" },
          { role: "user", content: "What's this?" },
        ],
      });

      expect(params.messages).toHaveLength(3);
      expect(params.messages[0]).toEqual({
        role: "system",
        content: "Primary Jack safety prompt",
      });
      expect(params.messages[1]?.role).toBe("system");
      expect(params.messages[1]?.content).toContain(
        "CURRENT JACK APPLICATION UI CONTEXT",
      );
      expect(params.messages[1]?.content).toContain(
        "path: Jack > Welding > FCAW",
      );
      expect(params.messages[2]).toEqual({
        role: "user",
        content: "What's this?",
      });
    });
  });

  it("does not inject invalid context", () => {
    const req = {
      get: () => "%7Bbad",
    } as unknown as Request;

    jackUiRequestContextMiddleware(req, {} as Response, () => {
      const params = {
        model: "gpt-4o-mini",
        messages: [{ role: "user" as const, content: "Hello" }],
      };
      expect(withJackUiRequestContext(params)).toBe(params);
    });
  });
});
