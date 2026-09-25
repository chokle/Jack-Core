import { describe, expect, it } from "vitest";
import { Quaternion, Vector3 } from "three";
import {
  arYawDegrees,
  mergeObservedPoints,
  observedDepthPoint,
  pointsInDeviceFrame,
} from "./radar-ar";

const projection = [1, 0, 0, 0, 0, 1];
const origin = { x: 0, y: 0, z: 0 };
const orientation = { x: 0, y: 0, z: 0, w: 1 };

describe("AR depth samples", () => {
  it("uses local AR turn rather than claiming geographic north", () => {
    expect(arYawDegrees(new Quaternion())).toBe(0);
    expect(
      arYawDegrees(
        new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -Math.PI / 2),
      ),
    ).toBeCloseTo(90);
  });
  it("plots measured camera-plane depth in the local device frame", () => {
    const point = observedDepthPoint(
      0.5,
      0.5,
      2,
      projection,
      origin,
      orientation,
      1,
    );
    expect(point).toEqual({ x: 0, y: 0, z: -2, seenAt: 1 });
    expect(
      pointsInDeviceFrame([point!], {
        ...origin,
        orientation: new Quaternion(),
      }),
    ).toEqual([{ x: 0, forward: 2, range: 2 }]);
  });

  it("accounts for an off-axis XR camera projection", () => {
    const offAxis = [1, 0, 0, 0, 0, 1, 0, 0, 0.25, -0.1];
    expect(
      observedDepthPoint(0.5, 0.5, 2, offAxis, origin, orientation, 1),
    ).toEqual({ x: 0.5, y: -0.2, z: -2, seenAt: 1 });
  });

  it("does not invent samples for invalid or out-of-range depth", () => {
    expect(
      observedDepthPoint(0.5, 0.5, 0, projection, origin, orientation, 1),
    ).toBeNull();
    expect(
      observedDepthPoint(0.5, 0.5, 51, projection, origin, orientation, 1),
    ).toBeNull();
    expect(
      observedDepthPoint(0.5, 0.5, NaN, projection, origin, orientation, 1),
    ).toBeNull();
  });

  it("expires old observations and merges nearby samples", () => {
    const old = { x: 0, y: 0, z: -2, seenAt: 1 };
    expect(
      mergeObservedPoints([old], [{ ...old, x: 0.1, seenAt: 2 }], 2),
    ).toEqual([old]);
    expect(mergeObservedPoints([old], [], 30_002)).toEqual([]);
  });
});
