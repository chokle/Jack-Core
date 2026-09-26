import assert from "node:assert/strict";
import { test } from "node:test";
import { limitedBytes, validateDepthPly } from "./radar-ply.mjs";

function depthPly(newline = "\n", points = [[1, 2, 3]]) {
  const header = new TextEncoder().encode(
    [
      "ply",
      "format binary_little_endian 1.0",
      `element vertex ${points.length}`,
      "property float x",
      "property float y",
      "property float z",
      "end_header",
      "",
    ].join(newline),
  );
  const bytes = new Uint8Array(header.length + points.length * 12);
  bytes.set(header);
  const view = new DataView(bytes.buffer);
  points
    .flat()
    .forEach((value, index) =>
      view.setFloat32(header.length + index * 4, value, true),
    );
  return bytes;
}

test("accepts phone depth points with LF and CRLF headers", () => {
  assert.equal(validateDepthPly(depthPly()), 1);
  assert.equal(
    validateDepthPly(
      depthPly("\r\n", [
        [1, 2, 3],
        [4, 5, 6],
      ]),
    ),
    2,
  );
});

test("rejects truncated and non-finite depth points", () => {
  assert.throws(
    () => validateDepthPly(depthPly().subarray(0, -1)),
    /incomplete/,
  );
  assert.throws(
    () => validateDepthPly(depthPly("\n", [[NaN, 2, 3]])),
    /non-finite/,
  );
});

test("reads a bounded scan request body", async () => {
  const file = depthPly();
  const bytes = await limitedBytes(
    new Request("https://example.test/upload", { method: "POST", body: file }),
  );
  assert.deepEqual(bytes, file);
});
