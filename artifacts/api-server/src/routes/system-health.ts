/**
 * system-health route — live Systems Health snapshot for the heartbeat widget.
 *
 * Deliberately DB-free and unauthenticated (matching the rest of the public API
 * surface): it reads only the in-process Vitality Engine gauges and returns the
 * five coarse, presentation-level fields the widget renders. It NEVER exposes
 * raw internals (in-flight counts, cpu/ram, queue depth), so polling it can
 * neither leak operational detail nor cost anything. Not rate-limited — it does
 * no work beyond a synchronous snapshot.
 */
import { Router } from "express";
import { GetSystemHealthResponse } from "@workspace/api-zod";
import { readSnapshot } from "../lib/vitality.js";

const router = Router();

router.get("/system-health", (_req, res) => {
  const snap = readSnapshot();
  const payload = GetSystemHealthResponse.parse({
    vitalityScore: snap.vitalityScore,
    heartbeatBPM: snap.heartbeatBPM,
    pulseColor: snap.pulseColor,
    status: snap.status,
    state: snap.state,
  });
  return res.json(payload);
});

export default router;
