import { describe, expect, it } from "vitest";
import { parseSiteScan } from "./SiteScanViewer";

function ply(points: number[][]): ArrayBuffer {
  const header = new TextEncoder().encode(
    `ply\nformat binary_little_endian 1.0\nelement vertex ${points.length}\nproperty float x\nproperty float y\nproperty float z\nend_header\n`,
  );
  const bytes = new Uint8Array(header.length + points.length * 12);
  bytes.set(header);
  const data = new DataView(bytes.buffer, header.length);
  points
    .flat()
    .forEach((value, index) => data.setFloat32(index * 4, value, true));
  return bytes.buffer;
}

describe("private site scan view", () => {
  it("parses binary depth points and centers a renderable 3D geometry", () => {
    const view = parseSiteScan(
      ply([
        [0, 0, 0],
        [2, 4, 6],
      ]),
    );
    expect(view.displayedPoints).toBe(2);
    expect(view.geometry.getAttribute("position").count).toBe(2);
    const position = view.geometry.getAttribute("position");
    expect(position.getX(0)).toBe(-1);
    expect(position.getX(1)).toBe(1);
    expect(view.radius).toBeGreaterThan(0);
    view.geometry.dispose();
  });

  it("rejects empty or non-finite geometry", () => {
    expect(() => parseSiteScan(ply([]))).toThrow();
    expect(() => parseSiteScan(ply([[Number.NaN, 0, 0]]))).toThrow();
  });

  it("materializes at most 50,000 points from a larger valid scan", () => {
    const scan = parseSiteScan(
      ply(Array.from({ length: 100_001 }, (_, index) => [index, 0, 0])),
    );
    expect(scan.pointCount).toBe(100_001);
    expect(scan.displayedPoints).toBe(33_334);
    expect(scan.geometry.getAttribute("position").count).toBe(33_334);
    scan.geometry.dispose();
  });
});
