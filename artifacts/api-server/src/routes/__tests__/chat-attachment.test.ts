import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AnalyzeJackAttachmentResponse } from "@workspace/api-zod";
import attachmentRouter from "../chat-attachment.js";

const model = vi.hoisted(() => ({ chatCompletion: vi.fn() }));
vi.mock("../../lib/openai.js", () => ({
  chatCompletion: model.chatCompletion,
  MODELS: { analysis: "gpt-4o-mini" },
}));

function appFor(userId?: string) {
  const app = express();
  if (userId)
    app.use((req, _res, next) => {
      req.userId = userId;
      next();
    });
  app.use("/api", attachmentRouter);
  return app;
}

beforeEach(() => {
  model.chatCompletion.mockReset();
  model.chatCompletion.mockResolvedValue({
    choices: [
      { message: { content: "The document says isolate power before work." } },
    ],
  });
});

describe("POST /api/chat/attachment", () => {
  it("answers from a bounded document without persisting or claiming Library knowledge", async () => {
    const response = await request(appFor("user-1"))
      .post("/api/chat/attachment")
      .field("message", "What does this say?")
      .attach("file", Buffer.from("Isolate power before work."), {
        filename: "procedure.txt",
        contentType: "text/plain",
      });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.answer).toContain("isolate power");
    expect(response.body.attachment).toEqual({
      kind: "document",
      retained: false,
      truncated: false,
    });
    expect(response.body.usedInternalKnowledge).toBe(false);
    expect(AnalyzeJackAttachmentResponse.safeParse(response.body).success).toBe(
      true,
    );
    expect(model.chatCompletion).toHaveBeenCalledOnce();
  });

  it("requires a server-resolved user", async () => {
    const response = await request(appFor())
      .post("/api/chat/attachment")
      .attach("file", Buffer.from("Isolate power"), {
        filename: "procedure.txt",
        contentType: "text/plain",
      });
    expect(response.status).toBe(401);
    expect(model.chatCompletion).not.toHaveBeenCalled();
  });

  it("rejects a renamed PDF before analysis", async () => {
    const response = await request(appFor("user-1"))
      .post("/api/chat/attachment")
      .attach("file", Buffer.from("not pdf"), {
        filename: "procedure.pdf",
        contentType: "application/pdf",
      });
    expect(response.status).toBe(415);
    expect(model.chatCompletion).not.toHaveBeenCalled();
  });

  it("does not ask the model for a code-compliance verdict from a file", async () => {
    const response = await request(appFor("user-1"))
      .post("/api/chat/attachment")
      .field("message", "Is this electrical installation code compliant?")
      .attach("file", Buffer.from("Panel notes"), {
        filename: "notes.txt",
        contentType: "text/plain",
      });
    expect(response.status).toBe(200);
    expect(response.body.answer).toContain("cannot verify code compliance");
    expect(model.chatCompletion).not.toHaveBeenCalled();
  });
});
