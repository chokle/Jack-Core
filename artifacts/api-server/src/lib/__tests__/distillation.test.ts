import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../supabase.js", async () => {
  const m = await import("./mocks.js");
  return { supabase: m.fake };
});

vi.mock("../openai.js", async () => {
  const m = await import("./mocks.js");
  return { createEmbedding: m.createEmbedding, MODELS: m.MODELS, openai: m.openai };
});

import {
  normalizeItems,
  distillTranscript,
  MAX_KNOWLEDGE_ITEMS,
  KNOWLEDGE_CATEGORIES,
} from "../distillation.js";
import { knowledgeNodeId } from "../memory-graph.js";
import { openai } from "./mocks.js";

const NO_CODES = new Set<string>();

/**
 * The shared mock `openai` singleton is an empty object; give it a spyable
 * `chat.completions.create` so distillTranscript tests can control (and assert
 * on) the model response without any network access.
 */
const createCompletion = vi.fn();
(openai as { chat: { completions: { create: typeof createCompletion } } }).chat = {
  completions: { create: createCompletion },
};

/** Build a chat-completions-shaped response wrapping the given message content. */
function completionWith(content: string | null | undefined) {
  return { choices: [{ message: { content } }] };
}

describe("normalizeItems", () => {
  it("returns an empty list for non-array / garbage input", () => {
    expect(normalizeItems(null, NO_CODES)).toEqual([]);
    expect(normalizeItems(undefined, NO_CODES)).toEqual([]);
    expect(normalizeItems("not an array", NO_CODES)).toEqual([]);
    expect(normalizeItems({}, NO_CODES)).toEqual([]);
    expect(normalizeItems(42, NO_CODES)).toEqual([]);
  });

  it("skips non-object array entries", () => {
    const items = normalizeItems(
      [null, "string", 5, ["nested"], { title: "Travel Speed", category: "concept" }],
      NO_CODES,
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe("Travel Speed");
  });

  it("drops entries with an invalid or missing category", () => {
    const items = normalizeItems(
      [
        { title: "Ok Concept", category: "concept" },
        { title: "Bad Category", category: "not-a-real-category" },
        { title: "Missing Category" },
        { title: "Empty Category", category: "" },
        { title: "Numeric Category", category: 7 },
      ],
      NO_CODES,
    );
    expect(items.map((i) => i.title)).toEqual(["Ok Concept"]);
  });

  it("accepts categories case-insensitively and with surrounding whitespace", () => {
    const items = normalizeItems(
      [
        { title: "Upper", category: "CONCEPT" },
        { title: "Padded", category: "  hazard  " },
        { title: "Mixed", category: "ToOl" },
      ],
      NO_CODES,
    );
    expect(items.map((i) => i.category).sort()).toEqual(["concept", "hazard", "tool"]);
  });

  it("drops entries with an empty or non-string title", () => {
    const items = normalizeItems(
      [
        { title: "Real Title", category: "concept" },
        { title: "", category: "concept" },
        { title: "   ", category: "concept" },
        { title: 123, category: "concept" },
        { category: "concept" },
        { title: "<b></b>", category: "concept" },
      ],
      NO_CODES,
    );
    expect(items.map((i) => i.title)).toEqual(["Real Title"]);
  });

  it("strips HTML from title and description", () => {
    const items = normalizeItems(
      [
        {
          title: "<script>alert(1)</script>Arc Blow",
          description: "A <b>magnetic</b> deflection <img src=x onerror=1> issue",
          category: "concept",
        },
      ],
      NO_CODES,
    );
    expect(items[0]?.title).toBe("alert(1)Arc Blow");
    expect(items[0]?.description).toBe("A magnetic deflection  issue");
    expect(items[0]?.title).not.toContain("<");
    expect(items[0]?.description).not.toContain("<");
  });

  it("defaults description to an empty string when missing or non-string", () => {
    const items = normalizeItems(
      [
        { title: "No Desc", category: "concept" },
        { title: "Num Desc", category: "tool", description: 5 },
      ],
      NO_CODES,
    );
    expect(items.every((i) => i.description === "")).toBe(true);
  });

  it("clamps confidence into [0,1] and defaults non-finite values to 0.5", () => {
    const items = normalizeItems(
      [
        { title: "High", category: "concept", confidence: 5 },
        { title: "Low", category: "tool", confidence: -3 },
        { title: "InRange", category: "hazard", confidence: 0.42 },
        { title: "Missing", category: "material", confidence: undefined },
        { title: "NaN", category: "procedure", confidence: "not a number" },
        { title: "Infinity", category: "slang", confidence: Infinity },
      ],
      NO_CODES,
    );
    const byTitle = Object.fromEntries(items.map((i) => [i.title, i.confidence]));
    expect(byTitle["High"]).toBe(1);
    expect(byTitle["Low"]).toBe(0);
    expect(byTitle["InRange"]).toBe(0.42);
    expect(byTitle["Missing"]).toBe(0.5);
    expect(byTitle["NaN"]).toBe(0.5);
    expect(byTitle["Infinity"]).toBe(0.5);
  });

  it("parses numeric-string confidence values", () => {
    const items = normalizeItems(
      [{ title: "Stringy", category: "concept", confidence: "0.7" }],
      NO_CODES,
    );
    expect(items[0]?.confidence).toBe(0.7);
  });

  it("only keeps competencyCode when it is in the valid set", () => {
    const items = normalizeItems(
      [
        { title: "Mapped", category: "concept", competencyCode: "W-3" },
        { title: "Unknown Code", category: "tool", competencyCode: "Z-99" },
        { title: "No Code", category: "hazard" },
        { title: "Padded Code", category: "material", competencyCode: "  W-3  " },
      ],
      new Set(["W-3"]),
    );
    const byTitle = Object.fromEntries(items.map((i) => [i.title, i.competencyCode]));
    expect(byTitle["Mapped"]).toBe("W-3");
    expect(byTitle["Unknown Code"]).toBeNull();
    expect(byTitle["No Code"]).toBeNull();
    expect(byTitle["Padded Code"]).toBe("W-3");
  });

  it("filters out invalid timestamps and sorts + dedupes the rest", () => {
    const items = normalizeItems(
      [
        {
          title: "Timing",
          category: "concept",
          timestamps: [10, 2, 2, -5, "3", "bad", NaN],
        },
      ],
      NO_CODES,
    );
    expect(items[0]?.timestamps).toEqual([2, 3, 10]);
  });

  it("caps at MAX_KNOWLEDGE_ITEMS, keeping the highest-confidence concepts", () => {
    const raw = Array.from({ length: MAX_KNOWLEDGE_ITEMS + 8 }, (_, i) => ({
      title: `Concept ${i}`,
      category: "concept",
      confidence: i / 100,
    }));
    const items = normalizeItems(raw, NO_CODES);
    expect(items).toHaveLength(MAX_KNOWLEDGE_ITEMS);
    const confidences = items.map((i) => i.confidence);
    const sortedDesc = [...confidences].sort((a, b) => b - a);
    expect(confidences).toEqual(sortedDesc);
    const lowest = Math.min(...confidences);
    const expectedLowest = (raw.length - MAX_KNOWLEDGE_ITEMS) / 100;
    expect(lowest).toBeCloseTo(expectedLowest, 10);
  });

  it("merges same normalized-title + category duplicates within one video", () => {
    const items = normalizeItems(
      [
        {
          title: "Travel Speed",
          category: "concept",
          description: "",
          timestamps: [10, 20],
          confidence: 0.4,
          competencyCode: null,
        },
        {
          title: "travel  speed",
          category: "concept",
          description: "How fast you move the torch",
          timestamps: [20, 30],
          confidence: 0.9,
          competencyCode: "W-3",
        },
      ],
      new Set(["W-3"]),
    );
    expect(items).toHaveLength(1);
    const merged = items[0]!;
    expect(merged.id).toBe(knowledgeNodeId("concept", "Travel Speed"));
    expect(merged.timestamps).toEqual([10, 20, 30]);
    expect(merged.confidence).toBe(0.9);
    expect(merged.description).toBe("How fast you move the torch");
    expect(merged.competencyCode).toBe("W-3");
  });

  it("does not merge same title across different categories", () => {
    const items = normalizeItems(
      [
        { title: "Grinder", category: "tool" },
        { title: "Grinder", category: "equipment" },
      ],
      NO_CODES,
    );
    expect(items).toHaveLength(2);
    expect(new Set(items.map((i) => i.category))).toEqual(new Set(["tool", "equipment"]));
  });

  it("assigns the canonical deterministic node id for each concept", () => {
    const items = normalizeItems(
      [{ title: "Root Opening", category: "concept" }],
      NO_CODES,
    );
    expect(items[0]?.id).toBe(knowledgeNodeId("concept", "Root Opening"));
  });

  it("accepts every declared knowledge category", () => {
    const raw = KNOWLEDGE_CATEGORIES.map((category, i) => ({
      title: `Item ${i}`,
      category,
    }));
    const items = normalizeItems(raw, NO_CODES);
    expect(items).toHaveLength(KNOWLEDGE_CATEGORIES.length);
  });
});

describe("distillTranscript", () => {
  beforeEach(() => {
    createCompletion.mockReset();
  });

  const baseInput = {
    title: "GTAW Root Pass",
    trade: "Welder",
    transcript: "Some real transcript text about welding technique.",
    segments: [] as { start: number; text: string }[],
    competencies: [] as { code: string; name: string; trade: string }[],
  };

  it("returns [] for an empty transcript without calling the model", async () => {
    const result = await distillTranscript({ ...baseInput, transcript: "" });
    expect(result).toEqual([]);
    expect(createCompletion).not.toHaveBeenCalled();
  });

  it("returns [] for a whitespace-only transcript without calling the model", async () => {
    const result = await distillTranscript({ ...baseInput, transcript: "   \n\t  " });
    expect(result).toEqual([]);
    expect(createCompletion).not.toHaveBeenCalled();
  });

  it("returns [] when segments contain only blank text and there is no transcript", async () => {
    const result = await distillTranscript({
      ...baseInput,
      transcript: "",
      segments: [
        { start: 0, text: "   " },
        { start: 1, text: "" },
      ],
    });
    expect(result).toEqual([]);
    expect(createCompletion).not.toHaveBeenCalled();
  });

  it("returns [] when the model returns non-JSON content (JSON.parse failure)", async () => {
    createCompletion.mockResolvedValue(completionWith("this is not json {{{"));
    const result = await distillTranscript(baseInput);
    expect(result).toEqual([]);
    expect(createCompletion).toHaveBeenCalledTimes(1);
  });

  it("returns [] when the model returns null/empty content", async () => {
    createCompletion.mockResolvedValue(completionWith(null));
    const result = await distillTranscript(baseInput);
    expect(result).toEqual([]);
  });

  it("returns [] when the parsed object has no 'knowledge' array", async () => {
    createCompletion.mockResolvedValue(completionWith(JSON.stringify({ notKnowledge: [] })));
    const result = await distillTranscript(baseInput);
    expect(result).toEqual([]);
  });

  it("returns [] when 'knowledge' is present but not an array", async () => {
    createCompletion.mockResolvedValue(
      completionWith(JSON.stringify({ knowledge: "oops, a string" })),
    );
    const result = await distillTranscript(baseInput);
    expect(result).toEqual([]);
  });

  it("passes only valid competency codes through to normalizeItems", async () => {
    createCompletion.mockResolvedValue(
      completionWith(
        JSON.stringify({
          knowledge: [
            { title: "Root Opening", category: "concept", competencyCode: "W-3" },
            { title: "Travel Speed", category: "concept", competencyCode: "Z-99" },
            { title: "Arc Blow", category: "hazard", competencyCode: "  W-3  " },
          ],
        }),
      ),
    );
    const result = await distillTranscript({
      ...baseInput,
      competencies: [{ code: "W-3", name: "Gas Metal Arc Welding", trade: "Welder" }],
    });
    const byTitle = Object.fromEntries(result.map((i) => [i.title, i.competencyCode]));
    expect(byTitle["Root Opening"]).toBe("W-3");
    expect(byTitle["Travel Speed"]).toBeNull();
    expect(byTitle["Arc Blow"]).toBe("W-3");
  });
});
