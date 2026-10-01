import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.hoisted(() => vi.fn());
vi.mock("../openai.js", () => ({
  openai: { audio: { transcriptions: { create } } },
  MODELS: { transcription: "whisper-1" },
}));
vi.mock("../logger.js", () => ({ logger: { warn: vi.fn() } }));
import { transcribeAudioBuffer } from "../transcription.js";

beforeEach(() => {
  create.mockReset();
  create.mockResolvedValue("  result  ");
});
describe("audio buffer adapter", () => {
  it("preserves default interview callers and trims transcription", async () => {
    expect(
      await transcribeAudioBuffer(Buffer.from("audio"), "answer.webm"),
    ).toBe("result");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ model: "whisper-1", response_format: "text" }),
      undefined,
    );
  });
  it("passes cancellation, timeout and retry options through to the provider", async () => {
    const options = {
      signal: new AbortController().signal,
      timeout: 30_000,
      maxRetries: 0,
    };
    await transcribeAudioBuffer(Buffer.from("audio"), "question.m4a", options);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ response_format: "text" }),
      options,
    );
  });
  it("rejects an empty clip before calling the provider", async () => {
    await expect(
      transcribeAudioBuffer(Buffer.alloc(0), "question.m4a"),
    ).rejects.toThrow("empty");
    expect(create).not.toHaveBeenCalled();
  });
});
