import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * End-to-end guardrail: a distillation failure must NEVER downgrade a video that
 * has already been transcribed/analyzed. `distillGraphSafe` (and the analysis
 * pipeline that calls it) run distillation best-effort — a thrown error is
 * caught, logged, and the video's status is left untouched at "ready".
 */

vi.mock("../../lib/supabase.js", async () => {
  const m = await import("../../lib/__tests__/mocks.js");
  return { supabase: m.fake };
});

vi.mock("../../lib/openai.js", async () => {
  const m = await import("../../lib/__tests__/mocks.js");
  return {
    createEmbedding: m.createEmbedding,
    createEmbeddings: async (texts: string[]) =>
      Promise.all(texts.map((t) => m.createEmbedding(t))),
    MODELS: m.MODELS,
    openai: m.openai,
  };
});

// The graph mirror is a derived view; stub it so these tests exercise only the
// analysis/distillation status contract, not real graph persistence.
vi.mock("../../lib/memory-graph.js", () => ({
  syncVideoGraph: vi.fn(),
  removeVideoGraph: vi.fn(),
}));

// Transcription is never invoked by the code paths under test, but videos.ts
// imports it at module load, so provide a stub.
vi.mock("../../lib/transcription.js", () => ({
  transcribeFromUrl: vi.fn(),
}));

// The heart of the test: force distillation to throw so we can prove the caller
// swallows it without touching the video status. `vi.hoisted` keeps the spy
// available inside the hoisted `vi.mock` factory.
const { runDistillation } = vi.hoisted(() => ({ runDistillation: vi.fn() }));
vi.mock("../../lib/distillation.js", () => ({ runDistillation }));

import { distillGraphSafe, runAnalysis } from "../videos.js";
import { logger } from "../../lib/logger.js";
import { fake, openai, resetMocks } from "../../lib/__tests__/mocks.js";

const createCompletion = vi.fn();
(openai as { chat: { completions: { create: typeof createCompletion } } }).chat = {
  completions: { create: createCompletion },
};

function completionWith(content: string | null | undefined) {
  return { choices: [{ message: { content } }] };
}

function seedVideo(row: Record<string, unknown>): void {
  fake.tables["videos"]!.push(row);
}

function videoStatus(id: string): unknown {
  return fake.tables["videos"]!.find((v) => v["id"] === id)?.["status"];
}

describe("distillGraphSafe — best-effort guardrail", () => {
  beforeEach(() => {
    resetMocks();
    runDistillation.mockReset();
    createCompletion.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("swallows a thrown distillation error, logs it, and leaves status unchanged", async () => {
    seedVideo({ id: "v1", title: "GTAW Root Pass", trade: "Welder", status: "ready" });
    const errorSpy = vi.spyOn(logger, "error");
    const boom = new Error("distillation blew up");
    runDistillation.mockRejectedValue(boom);

    // Must resolve — a rejection here would bubble into the caller and could
    // downgrade the video.
    await expect(distillGraphSafe("v1")).resolves.toBeUndefined();

    expect(runDistillation).toHaveBeenCalledOnce();
    expect(runDistillation).toHaveBeenCalledWith("v1");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: boom, videoId: "v1" }),
      "atomic knowledge distillation failed",
    );
    // The whole point: the ready video stays ready.
    expect(videoStatus("v1")).toBe("ready");
  });

  it("does not touch a non-ready video's status when distillation throws", async () => {
    // Even a still-processing row must not be flipped to "error" by a distill hiccup.
    seedVideo({ id: "v2", title: "Framing Basics", trade: "Carpenter", status: "analyzing" });
    runDistillation.mockRejectedValue(new Error("nope"));

    await expect(distillGraphSafe("v2")).resolves.toBeUndefined();

    expect(videoStatus("v2")).toBe("analyzing");
  });
});

describe("runAnalysis pipeline — a distillation hiccup cannot cascade into a failed ingestion", () => {
  beforeEach(() => {
    resetMocks();
    runDistillation.mockReset();
    createCompletion.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reaches 'ready' even when distillation throws at the end of analysis", async () => {
    seedVideo({
      id: "v1",
      title: "GTAW Root Pass",
      trade: "Welder",
      transcript: "real transcript about welding technique",
      analysis: null,
      status: "analyzing",
    });
    fake.tables["competencies"]!.push({
      code: "W-3",
      name: "Gas Metal Arc Welding",
      trade: "Welder",
    });

    createCompletion.mockResolvedValue(
      completionWith(
        JSON.stringify({
          analysis: "This video teaches root pass technique.",
          keyPoints: ["Keep a tight arc", "Control travel speed"],
          competencyCodes: ["W-3"],
        }),
      ),
    );

    // Distillation is the LAST step of runAnalysis — make it throw.
    const boom = new Error("distillation blew up");
    runDistillation.mockRejectedValue(boom);
    const errorSpy = vi.spyOn(logger, "error");

    await expect(runAnalysis("v1")).resolves.toBeUndefined();

    // Analysis succeeded and persisted, so the video is ready.
    expect(videoStatus("v1")).toBe("ready");
    const row = fake.tables["videos"]!.find((v) => v["id"] === "v1")!;
    expect(row["analysis"]).toBe("This video teaches root pass technique.");
    expect(row["competency_codes"]).toEqual(["W-3"]);

    // The distillation failure was logged...
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: boom, videoId: "v1" }),
      "atomic knowledge distillation failed",
    );
    // ...but it was contained inside distillGraphSafe — runAnalysis never entered
    // its own failure path (which would mean the error escaped the guardrail).
    expect(errorSpy).not.toHaveBeenCalledWith(expect.anything(), "Analysis failed");
  });
});
