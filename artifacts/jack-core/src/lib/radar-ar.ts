import { Quaternion, Vector3 } from "three";

export type ArPoint = { x: number; y: number; z: number; seenAt: number };
export type ArPose = {
  x: number;
  y: number;
  z: number;
  orientation: Quaternion;
};

/** Yaw in local AR coordinates; it is not a geographic compass bearing. */
export function arYawDegrees(orientation: Quaternion): number | null {
  const direction = new Vector3(0, 0, -1).applyQuaternion(orientation);
  if (Math.hypot(direction.x, direction.z) < 0.1) return null;
  return ((Math.atan2(direction.x, -direction.z) * 180) / Math.PI + 360) % 360;
}

/** Depth is camera-plane distance, not ray length. Keep only measured geometry. */
export function observedDepthPoint(
  u: number,
  v: number,
  meters: number,
  projection: readonly number[],
  position: { x: number; y: number; z: number },
  orientation: { x: number; y: number; z: number; w: number },
  seenAt: number,
): ArPoint | null {
  if (
    !Number.isFinite(meters) ||
    meters <= 0 ||
    meters > 50 ||
    !Number.isFinite(projection[0]) ||
    !Number.isFinite(projection[5]) ||
    !Number.isFinite(projection[8] ?? 0) ||
    !Number.isFinite(projection[9] ?? 0) ||
    projection[0] === 0 ||
    projection[5] === 0 ||
    ![
      u,
      v,
      position.x,
      position.y,
      position.z,
      orientation.x,
      orientation.y,
      orientation.z,
      orientation.w,
    ].every(Number.isFinite)
  )
    return null;
  const cameraPoint = new Vector3(
    ((2 * u - 1 + (projection[8] ?? 0)) * meters) / projection[0],
    ((1 - 2 * v + (projection[9] ?? 0)) * meters) / projection[5],
    -meters,
  );
  cameraPoint.applyQuaternion(
    new Quaternion(orientation.x, orientation.y, orientation.z, orientation.w),
  );
  cameraPoint.add(new Vector3(position.x, position.y, position.z));
  return { x: cameraPoint.x, y: cameraPoint.y, z: cameraPoint.z, seenAt };
}

export function pointsInDeviceFrame(points: readonly ArPoint[], pose: ArPose) {
  const direction = new Vector3(0, 0, -1).applyQuaternion(pose.orientation);
  const horizontal = Math.hypot(direction.x, direction.z);
  if (horizontal < 0.1) return [];
  const forwardX = direction.x / horizontal;
  const forwardZ = direction.z / horizontal;
  return points.flatMap((point) => {
    const dx = point.x - pose.x;
    const dz = point.z - pose.z;
    const right = dx * -forwardZ + dz * forwardX;
    const forward = dx * forwardX + dz * forwardZ;
    const range = Math.hypot(right, forward);
    return range <= 50 ? [{ x: right, forward, range }] : [];
  });
}

export function mergeObservedPoints(
  existing: readonly ArPoint[],
  next: readonly ArPoint[],
  now: number,
): ArPoint[] {
  const kept = existing.filter((point) => now - point.seenAt < 30_000);
  for (const point of next) {
    if (kept.some((old) => Math.hypot(old.x - point.x, old.z - point.z) < 0.35))
      continue;
    kept.push(point);
  }
  return kept.slice(-400);
}
