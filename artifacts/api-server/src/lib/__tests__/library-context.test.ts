import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../supabase.js", async () => ({
  supabase: (await import("./mocks.js")).fake,
}));
const state = vi.hoisted(() => ({ context: null as any }));
vi.mock("../jack-ui-request-context.js", () => ({
  currentJackUiRequestContext: () => state.context,
}));
import { loadLibraryContext } from "../library-context.js";
import { fake, resetMocks } from "./mocks.js";

beforeEach(() => {
  resetMocks();
  state.context = {
    surface: "Video",
    resources: [{ id: "e3", title: "untrusted title", selected: true }],
  };
  fake.tables.videos = [
    {
      id: "e3",
      title: "E-3: Bend a 30° EMT Offset",
      trade: "electrician",
      status: "completed",
      uploader_user_id: "owner",
    },
  ];
  fake.tables.transcript_segments = Array.from({ length: 9 }, (_, index) => ({
    id: String(index),
    video_id: "e3",
    start_time: index * 10,
    end_time: index * 10 + 9,
    text:
      index === 8
        ? "Mark the shrink allowance before bending."
        : "Set up the bender.",
  }));
});

describe("Library contextual retrieval", () => {
  it("uses the active ID without a title in the question and ranks a later relevant segment", async () => {
    const result = await loadLibraryContext(
      "What shrink allowance does this video show?",
      "owner",
    );
    expect(result.failure).toBeNull();
    expect(result.videos[0].title).toBe("E-3: Bend a 30° EMT Offset");
    expect((result.videos[0].transcript_segments as any[])[0]).toMatchObject({
      start_time: 80,
      end_time: 89,
      text: "Mark the shrink allowance before bending.",
    });
    expect(JSON.stringify(result)).not.toContain("untrusted title");
  });
  it("matches Library read access for another uploader's shared video", async () => {
    const result = await loadLibraryContext("Explain this video", "other-user");
    expect(result.failure).toBeNull();
    expect(result.videos[0].id).toBe("e3");
  });
  it("denies unauthenticated callers and nonexistent resource IDs", async () => {
    expect(
      (await loadLibraryContext("Explain this video", "")).failure,
    ).toContain("Sign in");
    state.context.resources[0].id = "missing";
    const result = await loadLibraryContext("Explain this video", "owner");
    expect(result.videos).toEqual([]);
    expect(result.failure).toContain("account's access");
  });
  it("spans the full recording for a natural overview", async () => {
    const result = await loadLibraryContext("Describe it", "owner");
    const segments = result.videos[0].transcript_segments as any[];
    expect(segments).toHaveLength(6);
    expect(segments[0].start_time).toBe(0);
    expect(segments.at(-1).start_time).toBe(80);
  });
  it("uses an explicitly named other video ahead of the selected video", async () => {
    fake.tables.videos.push({
      id: "3g",
      title: "3gdemo",
      analysis: "Vertical welding demonstration.",
      uploader_user_id: "other",
    });
    const result = await loadLibraryContext("Summarize 3gdemo", "owner", [
      "3gdemo",
    ]);
    expect(result.videos.map((video) => video.id)).toEqual(["3g"]);
  });
  it("resolves a natural named title on the Library", async () => {
    state.context = { surface: "Library", resources: [] };
    const result = await loadLibraryContext(
      "Summarize E-3: Bend a 30° EMT Offset",
      "owner",
    );
    expect(result.videos[0].id).toBe("e3");
  });
  it("asks which entry for ambiguous Library referents", async () => {
    fake.tables.videos.push({
      id: "3g",
      title: "3gdemo",
      analysis: "Welding.",
    });
    state.context = {
      surface: "Library",
      resources: [{ id: "e3" }, { id: "3g" }],
    };
    const result = await loadLibraryContext("Describe it", "owner");
    expect(result.videos).toEqual([]);
    expect(result.failure).toContain("Which one");
  });
  it("retrieves relevant evidence beyond the first database page", async () => {
    fake.tables.transcript_segments = Array.from(
      { length: 1002 },
      (_, index) => ({
        id: String(index),
        video_id: "e3",
        start_time: index * 10,
        end_time: index * 10 + 9,
        text:
          index === 1001 ? "Check the shrink allowance." : "Set up the bender.",
      }),
    );
    const result = await loadLibraryContext(
      "What shrink allowance does this video show?",
      "owner",
    );
    expect((result.videos[0].transcript_segments as any[])[0].start_time).toBe(
      10010,
    );
  });
  it("matches the short E-3 tutorial title and does not fall back to selected on an explicit missing title", async () => {
    fake.tables.videos[0].title = "E-3 Tutorial: Bend a 30 EMT Offset";
    state.context = { surface: "Library", resources: [] };
    expect(
      (await loadLibraryContext("Summarize the E-3 tutorial", "owner"))
        .videos[0].id,
    ).toBe("e3");
    state.context = {
      surface: "Video",
      resources: [{ id: "e3", selected: true }],
    };
    const missing = await loadLibraryContext(
      "Explain the video titled Missing",
      "owner",
      ["Missing"],
    );
    expect(missing.videos).toEqual([]);
    expect(missing.failure).toContain("named video");
  });
  it("filters rejected evidence and whole-video summaries for a named video", async () => {
    fake.tables.videos[0].analysis = "Unsafe rejected summary";
    fake.tables.knowledge_edges = [
      { source_id: "video:e3", target_id: "rejected", kind: "knowledge" },
    ];
    fake.tables.knowledge_nodes = [
      {
        id: "rejected",
        verification_status: "rejected",
        meta: { sources: [{ videoId: "e3", timestamps: [80] }] },
      },
    ];
    const result = await loadLibraryContext("Summarize E-3", "owner", ["E-3"]);
    expect(result.videos[0].analysis).toBeNull();
    expect(JSON.stringify(result)).not.toContain("shrink allowance");
    expect(JSON.stringify(result)).not.toContain("Unsafe rejected summary");
  });
  it("distinguishes processing from completed material with no content", async () => {
    fake.tables.transcript_segments = [];
    fake.tables.videos[0].status = "analyzing";
    expect(
      (await loadLibraryContext("Describe it", "owner")).failure,
    ).toContain("processing is analyzing");
  });
  it("keeps general explanations separate from the selected video", async () => {
    expect(await loadLibraryContext("Explain Ohms law", "owner")).toEqual({
      videos: [],
      failure: null,
    });
  });
  it("does not answer when reviewed evidence cannot be checked", async () => {
    fake.failNext("knowledge_edges", "select", { message: "unavailable" });
    const result = await loadLibraryContext("Explain this video", "owner");
    expect(result.videos).toEqual([]);
    expect(result.failure).toContain("reviewed evidence");
  });
  it("grounds colon and natural-language timestamp questions in the selected video", async () => {
    const colon = await loadLibraryContext("What happens at 1:20?", "owner");
    expect((colon.videos[0].transcript_segments as any[])[0].start_time).toBe(80);

    const seconds = await loadLibraryContext(
      "What happens at 10 seconds?",
      "owner",
    );
    expect((seconds.videos[0].transcript_segments as any[])[0].start_time).toBe(10);

    const combined = await loadLibraryContext(
      "What happens at 1 minute 20 seconds?",
      "owner",
    );
    expect((combined.videos[0].transcript_segments as any[])[0].start_time).toBe(80);

    expect(
      (await loadLibraryContext("Explain the analysis", "owner")).videos[0].id,
    ).toBe("e3");
  });
  it("treats selected-video citation language as media intent without leaking general questions", async () => {
    const cited = await loadLibraryContext("Cite the source at 10 sec", "owner");
    expect((cited.videos[0].transcript_segments as any[])[0].start_time).toBe(10);
    expect(await loadLibraryContext("What is 10 seconds in milliseconds?", "owner")).toEqual({
      videos: [],
      failure: null,
    });
  });
  it("identifies the authorized entry when transcript retrieval fails", async () => {
    fake.failNext("transcript_segments", "select", { message: "unavailable" });
    const result = await loadLibraryContext("Explain this video", "owner");
    expect(result.failure).toContain("E-3: Bend a 30° EMT Offset");
    expect(result.failure).toContain("couldn't retrieve its saved transcript");
    expect(result.videos).toEqual([]);
  });
  it("retains saved analysis when transcript lookup fails", async () => {
    fake.tables.videos[0].analysis = "A four-inch offset demonstration.";
    fake.failNext("transcript_segments", "select", { message: "unavailable" });
    const result = await loadLibraryContext("Explain this video", "owner");
    expect(result.failure).toBeNull();
    expect(result.videos[0].analysis).toContain("four-inch");
  });
  it("does not use resources from a background Library under an account dialog", async () => {
    state.context.surface = "Account settings";
    expect(await loadLibraryContext("Explain this screen", "owner")).toEqual({
      videos: [],
      failure: null,
    });
  });
});
