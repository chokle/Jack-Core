import { describe, expect, it } from "vitest";
import { addCapturePoints, capturePly } from "./radar-capture";
import type { ArPoint } from "./radar-ar";

const point = (x: number, y = 0, z = -2): ArPoint => ({ x, y, z, seenAt: 1 });

describe("local AR depth capture", () => {
  it("keeps separate 5 cm voxels and rejects invalid coordinates", () => {
    const captured = new Map<string, ArPoint>();
    addCapturePoints(captured, [point(0), point(0.01), point(0.1), point(NaN)]);
    expect([...captured.values()]).toEqual([point(0), point(0.1)]);
  });

  it("exports a binary PLY of local coordinates", async () => {
    const blob = capturePly([point(1, 2, 3)]);
    const bytes = await blob.arrayBuffer();
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("element vertex 1\n");
    expect(text).toContain("not surveyed or for navigation");
    const offset = text.indexOf("end_header\n") + "end_header\n".length;
    const coordinates = new DataView(bytes, offset);
    expect(coordinates.getFloat32(0, true)).toBe(1);
    expect(coordinates.getFloat32(4, true)).toBe(2);
    expect(coordinates.getFloat32(8, true)).toBe(3);
  });
});
