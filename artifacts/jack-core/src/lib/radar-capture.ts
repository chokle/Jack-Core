import type { ArPoint } from "./radar-ar";

const VOXEL_METERS = 0.05;
export const MAX_CAPTURE_POINTS = 50_000;

/** Keep a bounded local point set for a single AR session. */
export function addCapturePoints(
  captured: Map<string, ArPoint>,
  samples: readonly ArPoint[],
): void {
  for (const point of samples) {
    if (captured.size >= MAX_CAPTURE_POINTS) break;
    if (![point.x, point.y, point.z].every(Number.isFinite)) continue;
    const key = [point.x, point.y, point.z]
      .map((value) => Math.floor(value / VOXEL_METERS))
      .join(",");
    if (!captured.has(key)) captured.set(key, point);
  }
}

/** Binary PLY for local inspection; coordinates are AR-session metres, not surveyed. */
export function capturePly(points: readonly ArPoint[]): Blob {
  const header = `ply\nformat binary_little_endian 1.0\ncomment Local AR session; not surveyed or for navigation\nelement vertex ${points.length}\nproperty float x\nproperty float y\nproperty float z\nend_header\n`;
  const coordinates = new ArrayBuffer(points.length * 12);
  const view = new DataView(coordinates);
  for (let index = 0; index < points.length; index++) {
    const point = points[index]!;
    view.setFloat32(index * 12, point.x, true);
    view.setFloat32(index * 12 + 4, point.y, true);
    view.setFloat32(index * 12 + 8, point.z, true);
  }
  return new Blob([header, coordinates], { type: "application/octet-stream" });
}
