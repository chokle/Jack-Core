export type JackAttachmentKind = "photo" | "video" | "document";

/** Inspect bytes so a renamed file is not routed to the wrong Jack upload path. */
export async function classifyJackAttachment(
  file: File,
): Promise<JackAttachmentKind> {
  const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const ascii = (start: number, end: number) =>
    String.fromCharCode(...bytes.slice(start, end));
  const name = file.name.toLowerCase();
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = ascii(0, 8) === "\x89PNG\r\n\x1a\n";
  const webp = ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
  if (
    (jpeg && /\.jpe?g$/.test(name)) ||
    (png && name.endsWith(".png")) ||
    (webp && name.endsWith(".webp"))
  )
    return "photo";
  if (
    (ascii(4, 8) === "ftyp" && /\.(mp4|mov|m4v)$/.test(name)) ||
    (bytes[0] === 0x1a &&
      bytes[1] === 0x45 &&
      bytes[2] === 0xdf &&
      bytes[3] === 0xa3 &&
      name.endsWith(".webm"))
  )
    return "video";
  if (
    (ascii(0, 5) === "%PDF-" && name.endsWith(".pdf")) ||
    (ascii(0, 2) === "PK" && name.endsWith(".docx"))
  )
    return "document";
  // UTF-8 sequences may cross this short preview boundary; the server checks
  // the entire text file before passing any content to Jack.
  if (name.endsWith(".txt") && !bytes.includes(0)) return "document";
  throw new Error(
    "Use an actual JPG, PNG, WebP, MP4, MOV, WebM, PDF, DOCX, or TXT file.",
  );
}
