import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { readFileSync } from "node:fs";
import { readAskJackAttachment } from "../ask-jack-attachment.js";

describe("Ask Jack transient attachment reader", () => {
  it("normalizes a real photo from its bytes", async () => {
    const buffer = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "orange" },
    })
      .png()
      .toBuffer();
    const result = await readAskJackAttachment({
      buffer,
      originalname: "field.png",
      mimetype: "application/octet-stream",
    });
    expect(result.kind).toBe("photo");
    if (result.kind === "photo")
      expect(result.dataUrl).toMatch(/^data:image\/webp;base64,/);
  });

  it("reads bounded text without making it a persistent contribution", async () => {
    const result = await readAskJackAttachment({
      buffer: Buffer.from("Field procedure\n".repeat(2000)),
      originalname: "procedure.txt",
      mimetype: "text/plain",
    });
    expect(result.kind).toBe("document");
    if (result.kind === "document") {
      expect(result.text.length).toBe(16_000);
      expect(result.truncated).toBe(true);
    }
  });

  it("rejects a PDF name with non-PDF bytes", async () => {
    await expect(
      readAskJackAttachment({
        buffer: Buffer.from("plain text"),
        originalname: "renamed.pdf",
        mimetype: "application/pdf",
      }),
    ).rejects.toThrow("not a readable PDF");
  });

  it("rejects empty attachments", async () => {
    await expect(
      readAskJackAttachment({
        buffer: Buffer.alloc(0),
        originalname: "empty.txt",
        mimetype: "text/plain",
      }),
    ).rejects.toThrow("file is empty");
  });

  it("rejects a ZIP renamed to DOCX before expanding it", async () => {
    await expect(
      readAskJackAttachment({
        buffer: Buffer.from("PKnot-a-docx"),
        originalname: "renamed.docx",
        mimetype:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    ).rejects.toThrow("not a valid DOCX");
  });

  it("reads text from a real DOCX package", async () => {
    const result = await readAskJackAttachment({
      buffer: readFileSync(
        new URL("./fixtures/small-procedure.docx", import.meta.url),
      ),
      originalname: "small-procedure.docx",
      mimetype:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    expect(result.kind).toBe("document");
    if (result.kind === "document")
      expect(result.text).toContain("Turn off the breaker");
  });

  it("reads text from a real PDF page", async () => {
    const result = await readAskJackAttachment({
      buffer: readFileSync(
        new URL("./fixtures/small-procedure.pdf", import.meta.url),
      ),
      originalname: "small-procedure.pdf",
      mimetype: "application/pdf",
    });
    expect(result.kind).toBe("document");
    if (result.kind === "document")
      expect(result.text).toContain("Inspect the breaker");
  });
});
