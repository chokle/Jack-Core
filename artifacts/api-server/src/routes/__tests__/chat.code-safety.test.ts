import { beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express, type Request } from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { AskJackResponse } from "@workspace/api-zod";

const openAiMocks = vi.hoisted(() => ({
  createEmbedding: vi.fn(async () => [1, 0, 0]),
  chatCompletion: vi.fn(async () => ({
    choices: [{ message: { content: "Normal trade answer." } }],
  })),
}));
const learningMock = vi.hoisted(() =>
  vi.fn(async () => ({ status: "discarded", extractedCount: 0 })),
);

vi.mock("../../lib/supabase.js", async () => {
  const mocks = await import("../../lib/__tests__/mocks.js");
  return { supabase: mocks.fake };
});
vi.mock("../../lib/openai.js", () => ({
  createEmbedding: openAiMocks.createEmbedding,
  chatCompletion: openAiMocks.chatCompletion,
  MODELS: { chat: "test-chat", embedding: "test-embedding" },
}));
vi.mock("../../lib/ask-learning.js", () => ({
  learnFromAskInteraction: learningMock,
}));

import chatRouter from "../chat.js";
import { fake, resetMocks } from "../../lib/__tests__/mocks.js";
import {
  INITIAL_AUTHORITY_SOURCES,
  authoritativeSourceToRow,
} from "../../lib/code-authority.js";

function makeApp(): Express {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use((req: Request, _res, next) => {
    const noop = () => {};
    (req as unknown as { log: Record<string, () => void> }).log = {
      warn: noop,
      error: noop,
      info: noop,
      debug: noop,
    };
    (req as unknown as { userId: string }).userId = "user_code_gate";
    next();
  });
  app.use("/api", chatRouter);
  return app;
}

const app = makeApp();

beforeEach(() => {
  resetMocks();
  openAiMocks.createEmbedding.mockClear();
  openAiMocks.chatCompletion.mockClear();
  learningMock.mockClear();
  fake.tables["authoritative_sources"] = INITIAL_AUTHORITY_SOURCES.map(
    authoritativeSourceToRow,
  );
});

describe("Ask Jack code authority safety gate", () => {
  it("returns metadata-only BC guidance before embeddings or model invocation", async () => {
    const res = await request(app)
      .post("/api/chat")
      .send({
        message: "Is this venting to code?",
        authorityContext: {
          province: "BC",
          municipality: "Burnaby",
          permitApplicationDate: "2026-08-11",
          projectType: "new construction",
          knownConditions: [
            "New permit application; no delayed provisions apply",
          ],
          measurements: [
            { name: "trap arm length", value: "1200", unit: "mm" },
          ],
        },
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(() => AskJackResponse.parse(res.body)).not.toThrow();
    expect(res.body.codeSafety).toMatchObject({
      outcome: "blocked",
      jurisdiction: "BC_GENERAL",
      applicableEdition: "2024",
    });
    expect(res.body.answer).toContain("cannot issue a code-compliance ruling");
    expect(res.body.citations[0]).toMatchObject({
      sourceType: "authority",
      authority: "Province of British Columbia",
      documentTitle: "British Columbia Plumbing Code 2024",
      contentAvailability: "metadata_only",
      section: null,
    });
    expect(openAiMocks.createEmbedding).not.toHaveBeenCalled();
    expect(openAiMocks.chatCompletion).not.toHaveBeenCalled();
    expect(learningMock).not.toHaveBeenCalled();
    expect(fake.tables["chat_messages"]).toHaveLength(2);
  });

  it("never falls from Vancouver through to BC general", async () => {
    const res = await request(app)
      .post("/api/chat")
      .send({
        message: "Is this venting to code?",
        authorityContext: {
          province: "British Columbia",
          municipality: "Vancouver",
          permitApplicationDate: "2026-08-11",
          projectType: "new construction",
          knownConditions: [
            "New permit application; no delayed provisions apply",
          ],
          measurements: [{ name: "vent distance", value: "1.2", unit: "m" }],
        },
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.codeSafety.jurisdiction).toBe("VANCOUVER");
    expect(res.body.citations[0].authority).toBe("City of Vancouver");
    expect(
      res.body.citations.some(
        (citation: { documentTitle?: string }) =>
          citation.documentTitle === "British Columbia Plumbing Code 2024",
      ),
    ).toBe(false);
    expect(openAiMocks.chatCompletion).not.toHaveBeenCalled();
  });

  it("refuses an unknown municipality or AHJ without RAG", async () => {
    const res = await request(app)
      .post("/api/chat")
      .send({
        message: "What slope is required for this drain pipe?",
        authorityContext: {
          province: "BC",
          permitApplicationDate: "2026-08-11",
        },
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.codeSafety.jurisdiction).toBe("UNKNOWN_SPECIAL_AUTHORITY");
    expect(res.body.codeSafety.missing).toContain(
      "Municipality or authority having jurisdiction",
    );
    expect(openAiMocks.createEmbedding).not.toHaveBeenCalled();
  });

  it.each([
    "is this legal?",
    "can I install this?",
    "does this pass?",
    "what size does code require?",
    "inspection requirement",
    "minimum slope",
    "required clearance",
  ])("blocks required detector phrasing before RAG: %s", async (message) => {
    const res = await request(app).post("/api/chat").send({ message });
    expect(res.status).toBe(200);
    expect(res.body.codeSafety).toMatchObject({
      outcome: "blocked",
      sensitivity: { isCodeSensitive: true },
    });
    expect(openAiMocks.createEmbedding).not.toHaveBeenCalled();
    expect(openAiMocks.chatCompletion).not.toHaveBeenCalled();
    expect(learningMock).not.toHaveBeenCalled();
  });

  it("keeps normal non-code Ask Jack behavior unchanged", async () => {
    const res = await request(app)
      .post("/api/chat")
      .send({ message: "How do I keep a consistent torch angle?" });
    expect(res.status).toBe(200);
    expect(res.body.answer).toBe("Normal trade answer.");
    expect(res.body.codeSafety).toBeUndefined();
    expect(openAiMocks.createEmbedding).toHaveBeenCalledOnce();
    expect(openAiMocks.chatCompletion).toHaveBeenCalledOnce();
    expect(learningMock).toHaveBeenCalledOnce();
  });
});
