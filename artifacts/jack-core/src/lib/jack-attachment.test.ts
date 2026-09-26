import { describe, expect, it } from "vitest";
import { classifyJackAttachment } from "./jack-attachment";

describe("Ask Jack attachment routing", () => {
  it("routes by bytes and extension, not a misleading browser MIME type", async () => {
    const jpeg = new File(
      [Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])],
      "field.jpg",
      { type: "video/mp4" },
    );
    const video = new File([new Uint8Array(4), "ftypisom"], "sweep.mp4", {
      type: "image/jpeg",
    });
    const pdf = new File(["%PDF-1.7"], "procedure.pdf", { type: "text/plain" });
    expect(await classifyJackAttachment(jpeg)).toBe("photo");
    expect(await classifyJackAttachment(video)).toBe("video");
    expect(await classifyJackAttachment(pdf)).toBe("document");
  });

  it("rejects a renamed file instead of sending it to the wrong endpoint", async () => {
    const renamed = new File(["not a video"], "sweep.mp4", {
      type: "video/mp4",
    });
    await expect(classifyJackAttachment(renamed)).rejects.toThrow(
      "Use an actual",
    );
  });

  it("allows valid text when a UTF-8 character crosses the preview boundary", async () => {
    const text = new File(["123456789012345", "é field note"], "note.txt", {
      type: "text/plain",
    });
    expect(await classifyJackAttachment(text)).toBe("document");
  });
});
