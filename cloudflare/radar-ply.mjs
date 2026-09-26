const MAX_SCAN_BYTES = 25 * 1024 * 1024;

export async function limitedBytes(request) {
  if (!request.body) throw new Error("Empty scan body");
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_SCAN_BYTES) {
      await reader.cancel();
      throw new RangeError("Scan exceeds 25 MB limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function validateDepthPly(bytes) {
  const preview = new TextDecoder("ascii").decode(
    bytes.subarray(0, Math.min(bytes.length, 8192)),
  );
  const match = /(?:^|\n)end_header\r?\n/.exec(preview);
  if (!match) throw new Error("PLY header is missing");
  const headerBytes = match.index + match[0].length;
  const lines = preview
    .slice(0, headerBytes)
    .replace(/\r\n/g, "\n")
    .trimEnd()
    .split("\n");
  if (lines[0] !== "ply" || !lines.includes("format binary_little_endian 1.0"))
    throw new Error("Unsupported depth PLY format");
  const vertexLine = lines.find((line) => line.startsWith("element vertex "));
  const count = vertexLine
    ? Number(vertexLine.slice("element vertex ".length))
    : NaN;
  if (!Number.isInteger(count) || count < 1 || count > 2_000_000)
    throw new Error("Invalid depth point count");
  if (
    lines.some(
      (line) =>
        line.startsWith("element ") && !line.startsWith("element vertex "),
    )
  )
    throw new Error("Only depth points are supported");
  const properties = lines.filter((line) => line.startsWith("property "));
  if (
    properties.join("|") !==
    "property float x|property float y|property float z"
  )
    throw new Error("Depth points must have x, y, z float properties");
  if (bytes.length !== headerBytes + count * 12)
    throw new Error("Depth point data is incomplete");
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset + headerBytes,
    count * 12,
  );
  for (let i = 0; i < count * 3; i++) {
    if (!Number.isFinite(view.getFloat32(i * 4, true)))
      throw new Error("Depth point contains a non-finite coordinate");
  }
  return count;
}
