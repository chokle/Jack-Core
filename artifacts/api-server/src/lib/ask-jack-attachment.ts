import sharp from "sharp";
import mammoth from "mammoth";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export const MAX_ASK_JACK_ATTACHMENT_BYTES = 16 * 1024 * 1024;
const MAX_DOCUMENT_CHARS = 16_000;
const MAX_PDF_PAGES = 20;
const MAX_DOCX_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;

export class AttachmentError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function validateDocxEnvelope(buffer: Buffer): void {
  // A small ZIP can expand to an unbounded document. Check the central directory
  // before handing it to Mammoth; reject ZIP64 and encrypted entries.
  let end = -1;
  for (
    let offset = buffer.length - 22;
    offset >= Math.max(0, buffer.length - 65_557);
    offset--
  ) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      end = offset;
      break;
    }
  }
  if (end < 0)
    throw new AttachmentError(
      422,
      "That Word document is not a valid DOCX file.",
    );
  const count = buffer.readUInt16LE(end + 10);
  const size = buffer.readUInt32LE(end + 12);
  let cursor = buffer.readUInt32LE(end + 16);
  if (count < 1 || count > 400 || cursor + size > end)
    throw new AttachmentError(
      422,
      "That Word document is too complex to read here.",
    );
  let total = 0;
  for (let entry = 0; entry < count; entry++) {
    if (
      cursor + 46 > buffer.length ||
      buffer.readUInt32LE(cursor) !== 0x02014b50
    )
      throw new AttachmentError(
        422,
        "That Word document is not a valid DOCX file.",
      );
    const flags = buffer.readUInt16LE(cursor + 8);
    const uncompressed = buffer.readUInt32LE(cursor + 24);
    if ((flags & 1) !== 0 || uncompressed === 0xffffffff)
      throw new AttachmentError(
        422,
        "Encrypted or ZIP64 Word documents are not supported.",
      );
    total += uncompressed;
    if (total > MAX_DOCX_UNCOMPRESSED_BYTES)
      throw new AttachmentError(
        413,
        "The expanded Word document is too large to read here.",
      );
    cursor +=
      46 +
      buffer.readUInt16LE(cursor + 28) +
      buffer.readUInt16LE(cursor + 30) +
      buffer.readUInt16LE(cursor + 32);
  }
  if (cursor !== buffer.readUInt32LE(end + 16) + size)
    throw new AttachmentError(
      422,
      "That Word document is not a valid DOCX file.",
    );
}

export async function readAskJackAttachment(file: {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
}): Promise<
  | { kind: "photo"; dataUrl: string }
  | { kind: "document"; text: string; truncated: boolean }
> {
  const name = file.originalname.toLowerCase();
  const buffer = file.buffer;
  if (!buffer.length) throw new AttachmentError(400, "The file is empty.");
  if (buffer.length > MAX_ASK_JACK_ATTACHMENT_BYTES)
    throw new AttachmentError(
      413,
      "Photos and documents must be 16 MiB or smaller.",
    );

  if (/\.(jpe?g|png|webp)$/.test(name)) {
    const signature = buffer
      .subarray(0, 3)
      .equals(Buffer.from([0xff, 0xd8, 0xff]))
      ? "image/jpeg"
      : buffer
            .subarray(0, 8)
            .equals(
              Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            )
        ? "image/png"
        : buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
            buffer.subarray(8, 12).toString("ascii") === "WEBP"
          ? "image/webp"
          : null;
    const expected = /\.jpe?g$/.test(name)
      ? "image/jpeg"
      : name.endsWith(".png")
        ? "image/png"
        : "image/webp";
    if (signature !== expected)
      throw new AttachmentError(
        415,
        "The photo format does not match the file.",
      );
    try {
      const normalized = await sharp(buffer, { limitInputPixels: 40_000_000 })
        .rotate()
        .resize({
          width: 2048,
          height: 2048,
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality: 82 })
        .toBuffer();
      return {
        kind: "photo",
        dataUrl: `data:image/webp;base64,${normalized.toString("base64")}`,
      };
    } catch {
      throw new AttachmentError(422, "Jack could not read that photo.");
    }
  }

  let text: string;
  if (name.endsWith(".pdf")) {
    if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-")
      throw new AttachmentError(415, "That is not a readable PDF.");
    let pdf;
    try {
      pdf = await getDocument({
        data: new Uint8Array(buffer),
        useSystemFonts: true,
      }).promise;
      const pages: string[] = [];
      for (
        let pageNumber = 1;
        pageNumber <= Math.min(pdf.numPages, MAX_PDF_PAGES);
        pageNumber++
      ) {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        pages.push(
          `[Page ${pageNumber}] ${content.items
            .map((item) => ("str" in item ? item.str : ""))
            .join(" ")}`,
        );
        if (pages.join("\n").length >= MAX_DOCUMENT_CHARS) break;
      }
      text = pages.join("\n");
      if (pdf.numPages > MAX_PDF_PAGES) text += "\n[More pages were not read.]";
    } catch {
      throw new AttachmentError(
        422,
        "Jack could not extract text from that PDF.",
      );
    } finally {
      await pdf?.destroy();
    }
  } else if (name.endsWith(".docx")) {
    if (buffer.subarray(0, 2).toString("ascii") !== "PK")
      throw new AttachmentError(415, "That is not a readable Word document.");
    validateDocxEnvelope(buffer);
    try {
      text = (await mammoth.extractRawText({ buffer })).value;
    } catch {
      throw new AttachmentError(
        422,
        "Jack could not extract text from that Word document.",
      );
    }
  } else if (name.endsWith(".txt")) {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw new AttachmentError(
        422,
        "Jack could not read that text file as UTF-8.",
      );
    }
  } else {
    throw new AttachmentError(
      415,
      "Use a JPG, PNG, WebP, PDF, DOCX, or TXT file.",
    );
  }

  const clean = text.replace(/\u0000/g, "").trim();
  if (!clean) {
    throw new AttachmentError(
      422,
      "No selectable text was found. For a scanned page, send a photo instead.",
    );
  }
  return {
    kind: "document",
    text: clean.slice(0, MAX_DOCUMENT_CHARS),
    truncated:
      clean.length > MAX_DOCUMENT_CHARS ||
      text.includes("[More pages were not read.]"),
  };
}
