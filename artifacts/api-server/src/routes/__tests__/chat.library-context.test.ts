import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
vi.mock("../../lib/supabase.js", async () => ({
  supabase: (await import("../../lib/__tests__/mocks.js")).fake,
}));
vi.mock("../../lib/openai.js", async () => {
  const m = await import("../../lib/__tests__/mocks.js");
  return {
    ...m,
    chatCompletion: vi.fn(async () => ({
      choices: [
        {
          message: {
            content:
              "The E-3 video demonstrates an EMT offset; mark the shrink allowance at 1:20.",
          },
        },
      ],
    })),
  };
});
vi.mock("../../lib/ask-learning.js", () => ({
  learnFromAskInteraction: vi.fn(async () => ({
    status: "discarded",
    extractedCount: 0,
  })),
}));
import chatRouter from "../chat.js";
import { jackUiRequestContextMiddleware } from "../../lib/jack-ui-request-context.js";
import { fake, resetMocks } from "../../lib/__tests__/mocks.js";
import { chatCompletion } from "../../lib/openai.js";

const app = express();
app.use(express.json(), cookieParser());
app.use((req, _res, next) => {
  req.userId = req.get("x-test-user") ?? "owner";
  req.log = { error() {}, warn() {}, info() {}, debug() {} } as any;
  next();
});
app.use(jackUiRequestContextMiddleware);
app.use("/api", chatRouter);
function header() {
  return encodeURIComponent(
    JSON.stringify({
      version: 1,
      route: "/app",
      surface: "Video",
      path: ["Library", "EMT Offset"],
      inspector: { open: false, label: null },
      visibleIds: ["e3"],
      resources: [
        {
          id: "e3",
          title: "EMT Offset",
          trade: "electrician",
          status: "completed",
          selected: true,
        },
      ],
      navigation: {
        canBack: true,
        canUp: true,
        canForward: false,
        hasSourceAction: false,
      },
      capturedAt: new Date().toISOString(),
    }),
  );
}
beforeEach(() => {
  resetMocks();
  vi.mocked(chatCompletion).mockClear();
  fake.tables.videos = [
    {
      id: "e3",
      title: "E-3 EMT Offset",
      uploader_user_id: "owner",
      status: "completed",
      trade: "electrician",
    },
  ];
  fake.tables.transcript_segments = [
    {
      id: "seg",
      video_id: "e3",
      text: "Mark the shrink allowance before bending.",
      start_time: 80,
      end_time: 89,
    },
  ];
});
describe("Ask Jack Library request path", () => {
  it("passes indexed media to the model and returns a timestamp citation without a title in the question", async () => {
    const result = await request(app)
      .post("/api/chat")
      .set("X-Jack-Context", header())
      .send({ message: "What is this video showing me?" });
    expect(result.status).toBe(200);
    expect(result.body.usedInternalKnowledge).toBe(true);
    expect(result.body.citations).toContainEqual(
      expect.objectContaining({
        videoId: "e3",
        startTime: 80,
        endTime: 89,
        videoTitle: "E-3 EMT Offset",
      }),
    );
    const prompt = JSON.stringify(
      vi.mocked(chatCompletion).mock.calls[0][0].messages,
    );
    expect(prompt).toContain("Mark the shrink allowance before bending.");
    expect(prompt).toContain("E-3 EMT Offset");
    expect(prompt).toContain("Do not claim you lack access to this video");
  });
  it("returns an honest known-title failure without model speculation or fallback retrieval", async () => {
    fake.tables.transcript_segments = [];
    const result = await request(app)
      .post("/api/chat")
      .set("X-Jack-Context", header())
      .send({ message: "What is this video showing me?" });
    expect(result.status).toBe(200);
    expect(result.body.answer).toContain("E-3 EMT Offset");
    expect(result.body.answer).not.toContain("tell me");
    expect(result.body.citations).toEqual([]);
    expect(chatCompletion).not.toHaveBeenCalled();
  });
  it("cannot use a forged UI resource to read another user's transcript", async () => {
    const result = await request(app)
      .post("/api/chat")
      .set("x-test-user", "other")
      .set("X-Jack-Context", header())
      .send({ message: "Explain this video" });
    expect(result.status).toBe(200);
    expect(JSON.stringify(result.body)).not.toContain("shrink");
    expect(result.body.citations).toEqual([]);
    expect(chatCompletion).not.toHaveBeenCalled();
  });
});
