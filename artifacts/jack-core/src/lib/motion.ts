import { useEffect, useState } from "react";

/**
 * Shared motion policy — the single source of truth for whether animations run.
 *
 * There are two tiers of motion in jack-core:
 *
 * 1. TRANSITION motion — count-ups, width/opacity transitions, enter/exit
 *    slide-ins. This is incidental UI motion and HONORS the OS
 *    `prefers-reduced-motion` setting. Read it with `prefersReducedMotion()`
 *    or the `usePrefersReducedMotion()` hook.
 *
 * 2. AMBIENT / signature motion — the always-on brand effects that ARE the
 *    product's identity: the Systems-Health ECG heartbeat, the Living-Memory
 *    neuron firing + neural-flow pulse, and the background knowledge-graph
 *    wallpaper. These are small, low-amplitude, non-vestibular effects. Per an
 *    explicit product-owner decision they run REGARDLESS of the OS reduce-motion
 *    setting, because many desktops default "Reduce Motion" on (the common
 *    macOS/Windows default, and the default in headless/preview Chromium), which
 *    would otherwise silently disable the app's signature animations on desktop
 *    while leaving them on for phones. Gate these with `ambientMotionEnabled()`.
 *
 * Because every animation reads its "should I move?" decision from here, the
 * behavior can be changed in exactly one place — this is the shared switch that
 * previously lived as scattered inline `matchMedia` reads across five files.
 */

/**
 * True when the OS asks for reduced motion. The optional-chaining / `?? false`
 * guard keeps it safe under jsdom (tests that don't mock `matchMedia`).
 */
export function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/**
 * Product-owner policy: the signature ambient brand animations always run.
 * Flip this single constant to `false` to make ambient motion honor the OS
 * reduce-motion setting again (restoring strict accessibility behavior).
 */
const AMBIENT_MOTION_ALWAYS_ON: boolean = true;

/** True when ambient / signature animations (ECG, neuron firing, wallpaper) should run. */
export function ambientMotionEnabled(): boolean {
  if (AMBIENT_MOTION_ALWAYS_ON) return true;
  return !prefersReducedMotion();
}

/**
 * React hook mirroring `prefersReducedMotion()` for transition-tier motion.
 * Re-renders when the OS setting changes.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}
