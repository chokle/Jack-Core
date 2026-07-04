import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

// Liveness probe. Deliberately shallow (no DB / OpenAI dependency) so a transient
// Supabase or upstream blip can never fail the deployment healthcheck and trigger
// a restart loop. Served at BOTH the service base path (`/api`) and `/api/healthz`
// so any platform or external uptime check that pings the API root returns 200 —
// a bare `/api` previously 404'd, which read as an outage to uptime monitors.
router.get("/", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

export default router;
