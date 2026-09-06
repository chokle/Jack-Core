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
  it("does not expose another uploader's media through a forged resource ID", async () => {
    const result = await loadLibraryContext("Explain this video", "other-user");
    expect(result.videos).toEqual([]);
    expect(result.failure).toContain("account's access");
    expect(JSON.stringify(result)).not.toContain("shrink");
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
