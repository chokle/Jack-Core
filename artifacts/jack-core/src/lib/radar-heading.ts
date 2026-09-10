export function normalizeHeading(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

/** Only an earth-referenced reading is usable; relative alpha is not north. */
export function compassHeading(
  event: {
    alpha: number | null;
    beta?: number | null;
    gamma?: number | null;
    absolute: boolean;
    webkitCompassHeading?: number;
    webkitCompassAccuracy?: number;
  },
  screenAngle = 0,
): number | null {
  if (
    event.beta == null ||
    event.gamma == null ||
    !Number.isFinite(event.beta) ||
    !Number.isFinite(event.gamma) ||
    Math.abs(event.beta) > 25 ||
    Math.abs(event.gamma) > 25
  )
    return null;
  if (
    typeof event.webkitCompassHeading === "number" &&
    Number.isFinite(event.webkitCompassHeading) &&
    event.webkitCompassHeading >= 0 &&
    event.webkitCompassHeading <= 360 &&
    (event.webkitCompassAccuracy === undefined ||
      (Number.isFinite(event.webkitCompassAccuracy) &&
        event.webkitCompassAccuracy >= 0 &&
        event.webkitCompassAccuracy <= 45))
  ) {
    return normalizeHeading(event.webkitCompassHeading + screenAngle);
  }
  return event.absolute &&
    event.alpha !== null &&
    Number.isFinite(event.alpha) &&
    event.alpha >= 0 &&
    event.alpha <= 360
    ? normalizeHeading(360 - event.alpha + screenAngle)
    : null;
}

/** Clockwise bearing from north for a fixture position about the viewer. */
export function radarBearing(x: number, y: number): number {
  return normalizeHeading((Math.atan2(x - 50, 50 - y) * 180) / Math.PI);
}

/** Distance from the viewer in plan units, converted to the site's meter scale. */
export function radarDistanceMeters(
  x: number,
  y: number,
  metersPerPlanUnit = 1,
): number {
  return Math.round(Math.hypot(x - 50, y - 50) * metersPerPlanUnit);
}

export function contactIllumination(
  bearing: number,
  heading: number,
  sweep: number,
): number {
  const age = normalizeHeading(sweep - normalizeHeading(bearing - heading));
  return 0.3 + 0.7 * Math.max(0, 1 - age / 110);
}
/** Four pulses per revolution, fading during the first 40% of each quarter. */
export function sweepPulseOpacity(sweepDegrees: number): number {
  const phase = ((sweepDegrees % 90) + 90) % 90;
  return Math.max(0, 1 - phase / 36);
}
