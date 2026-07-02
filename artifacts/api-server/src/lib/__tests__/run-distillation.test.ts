import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../supabase.js", async () => {
  const m = await import("./mocks.js");
  return { supabase: m.fake };
});

vi.mock("../openai.js", async () => {
  const m = await import("./mocks.js");
  return { createEmbedding: m.createEmbedding, MODELS: m.MODELS, openai: m.openai };
});

/**
 * Spy on syncVideoKnowledge while keeping the rest of memory-graph real
 * (knowledgeNodeId is used to assert the canonical ids of the persisted items).
 */
vi.mock("../memory-graph.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../memory-graph.js")>();
  return { ...actual, syncVideoKnowledge: vi.fn() };
});

import { runDistillation } from "../distillation.js";
import {
  knowledgeNodeId,
  syncVideoKnowledge,
  type GraphWriteManifest,
} from "../memory-graph.js";
import { logger } from "../logger.js";
import { fake, openai, resetMocks } from "./mocks.js";

/**
 * A sentinel write manifest returned by the mocked syncVideoKnowledge. The real
 * manifest content is proven in memory-graph's own tests; here we only assert
 * that runDistillation surfaces whatever the sync step returned (so the indexing
 * stage can verify it) versus null when there is nothing to distill.
 */
const MANIFEST: GraphWriteManifest = {
  scope: "video",
  refId: "v1",
  sourceNodeId: "video:v1",
  expectedNodeIds: [],
  expectedEdgeIds: [],
  embeddingNodeIds: [],
};

/**
 * The shared mock `openai` singleton is an empty object; give it a spyable
 * `chat.completions.create` so runDistillation's inner distillTranscript call is
 * fully deterministic and offline.
 */
const createCompletion = vi.fn();
(openai as { chat: { completions: { create: typeof createCompletion } } }).chat = {
  completions: { create: createCompletion },
};

function completionWith(content: string | null | undefined) {
  return { choices: [{ message: { content } }] };
}

const syncMock = vi.mocked(syncVideoKnowledge);

const realFrom = fake.from.bind(fake);

/**
 * Force `supabase.from(<table>)` to resolve to a Supabase-shaped error result for
 * one specific table, delegating every other table to the real in-memory fake.
 * Models a read failure at exactly one step of the pipeline.
 */
function failReadOn(table: string, message: string): { message: string } {
  const error = { message };
  vi.spyOn(fake, "from").mockImplementation((t: string) => {
    if (t !== table) return realFrom(t);
    const result = { data: null, error };
    const builder = {
      select: () => builder,
      eq: () => builder,
      order: () => builder,
      maybeSingle: () => builder,
      single: () => builder,
      then: (
        onf?: ((v: unknown) => unknown) | null,
        onr?: ((r: unknown) => unknown) | null,
      ) => Promise.resolve(result).then(onf, onr),
    };
    return builder as unknown as ReturnType<typeof realFrom>;
  });
  return error;
}

function seedVideo(row: Record<string, unknown>): void {
  fake.tables["videos"]!.push(row);
}

describe("runDistillation — pipeline step", () => {
  beforeEach(() => {
    resetMocks();
    createCompletion.mockReset();
    syncMock.mockReset();
    syncMock.mockResolvedValue(MANIFEST);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips (no model call, no sync) when the video is missing", async () => {
    const infoSpy = vi.spyOn(logger, "info");

    await expect(runDistillation("nope")).resolves.toBeNull();

    expect(createCompletion).not.toHaveBeenCalled();
    expect(syncMock).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ videoId: "nope" }),
      "distillation skipped: no transcript",
    );
  });

  it("skips when the video has an empty transcript", async () => {
    seedVideo({ id: "v1", title: "Empty", trade: "Welder", transcript: "", status: "ready" });

    await expect(runDistillation("v1")).resolves.toBeNull();

    expect(createCompletion).not.toHaveBeenCalled();
    expect(syncMock).not.toHaveBeenCalled();
  });

  it("skips when the video transcript is only whitespace", async () => {
    seedVideo({
      id: "v1",
      title: "Blank",
      trade: "Welder",
      transcript: "   \n\t  ",
      status: "ready",
    });

    await expect(runDistillation("v1")).resolves.toBeNull();

    expect(createCompletion).not.toHaveBeenCalled();
    expect(syncMock).not.toHaveBeenCalled();
  });

  it("skips when transcript is a non-string (null) value", async () => {
    seedVideo({ id: "v1", title: "Null", trade: "Welder", transcript: null, status: "ready" });

    await expect(runDistillation("v1")).resolves.toBeNull();

    expect(createCompletion).not.toHaveBeenCalled();
    expect(syncMock).not.toHaveBeenCalled();
  });

  it("throws (never syncs) when the videos read errors", async () => {
    const error = failReadOn("videos", "videos read failed");

    await expect(runDistillation("v1")).rejects.toEqual(error);

    expect(createCompletion).not.toHaveBeenCalled();
    expect(syncMock).not.toHaveBeenCalled();
  });

  it("throws (never syncs) when the transcript_segments read errors", async () => {
    seedVideo({
      id: "v1",
      title: "GTAW Root Pass",
      trade: "Welder",
      transcript: "real transcript about welding",
      status: "ready",
    });
    const error = failReadOn("transcript_segments", "segments read failed");

    await expect(runDistillation("v1")).rejects.toEqual(error);

    expect(createCompletion).not.toHaveBeenCalled();
    expect(syncMock).not.toHaveBeenCalled();
  });

  it("throws (never syncs) when the competencies read errors", async () => {
    seedVideo({
      id: "v1",
      title: "GTAW Root Pass",
      trade: "Welder",
      transcript: "real transcript about welding",
      status: "ready",
    });
    const error = failReadOn("competencies", "competencies read failed");

    await expect(runDistillation("v1")).rejects.toEqual(error);

    expect(createCompletion).not.toHaveBeenCalled();
    expect(syncMock).not.toHaveBeenCalled();
  });

  it("distills and syncs the normalized items on the happy path", async () => {
    seedVideo({
      id: "v1",
      title: "GTAW Root Pass",
      trade: "Welder",
      transcript: "real transcript about welding technique",
      status: "ready",
    });
    fake.tables["transcript_segments"]!.push(
      { video_id: "v1", start_time: 1.5, text: "root opening basics" },
      { video_id: "v1", start_time: 12, text: "travel speed matters" },
    );
    fake.tables["competencies"]!.push({
      code: "W-3",
      name: "Gas Metal Arc Welding",
      trade: "Welder",
    });

    createCompletion.mockResolvedValue(
      completionWith(
        JSON.stringify({
          knowledge: [
            {
              title: "Root Opening",
              category: "concept",
              description: "The gap at the joint root",
              timestamps: [1.5],
              confidence: 0.9,
              competencyCode: "W-3",
            },
            {
              title: "Travel Speed",
              category: "concept",
              timestamps: [12],
              confidence: 0.7,
              competencyCode: "Z-99",
            },
          ],
        }),
      ),
    );

    await expect(runDistillation("v1")).resolves.toBe(MANIFEST);

    expect(createCompletion).toHaveBeenCalledTimes(1);
    expect(syncMock).toHaveBeenCalledTimes(1);

    const [videoIdArg, itemsArg] = syncMock.mock.calls[0]!;
    expect(videoIdArg).toBe("v1");
    expect(itemsArg).toHaveLength(2);

    const byTitle = Object.fromEntries(itemsArg.map((i) => [i.title, i]));
    expect(byTitle["Root Opening"]!.id).toBe(knowledgeNodeId("concept", "Root Opening"));
    expect(byTitle["Root Opening"]!.competencyCode).toBe("W-3");
    // Z-99 is not a seeded competency, so it is normalized away to null.
    expect(byTitle["Travel Speed"]!.competencyCode).toBeNull();
  });

  it("still syncs (with an empty list) when the model yields no valid knowledge", async () => {
    seedVideo({
      id: "v1",
      title: "GTAW Root Pass",
      trade: "Welder",
      transcript: "real transcript about welding technique",
      status: "ready",
    });

    createCompletion.mockResolvedValue(completionWith(JSON.stringify({ knowledge: [] })));

    await expect(runDistillation("v1")).resolves.toBe(MANIFEST);

    expect(createCompletion).toHaveBeenCalledTimes(1);
    expect(syncMock).toHaveBeenCalledTimes(1);
    const [videoIdArg, itemsArg] = syncMock.mock.calls[0]!;
    expect(videoIdArg).toBe("v1");
    expect(itemsArg).toEqual([]);
  });
});
