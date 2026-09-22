import { Router } from "express";
import { getAdminReviewer, requireAdmin } from "../lib/admin-auth.js";
import { readDazRuntimeStatus } from "../lib/daz-runtime.js";
import { GetDazTaskParams } from "@workspace/api-zod";
import {
  requestDazTask,
  RuntimeTaskError,
  taskRequest,
} from "../lib/daz-tasks.js";

const router = Router();

router.post("/daz-runtime/tasks", requireAdmin, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const input = taskRequest.safeParse(req.body);
  if (!input.success)
    return res.status(400).json({
      ok: false,
      error: "A valid task_id and jack_health_report kind are required.",
    });
  if (!req.admin?.userId)
    return res
      .status(403)
      .json({ ok: false, error: "Admin identity unavailable." });
  try {
    return res.json(
      await requestDazTask(input.data.task_id, req.admin.userId, true),
    );
  } catch (error) {
    return res
      .status(error instanceof RuntimeTaskError ? error.status : 503)
      .json({
        ok: false,
        error:
          "Task submission could not be confirmed. Retrieve or retry the same task ID.",
      });
  }
});

router.get("/daz-runtime/tasks/:id", requireAdmin, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const id = GetDazTaskParams.safeParse(req.params);
  if (!id.success)
    return res.status(400).json({ ok: false, error: "Invalid task ID." });
  if (!req.admin?.userId)
    return res
      .status(403)
      .json({ ok: false, error: "Admin identity unavailable." });
  try {
    return res.json(await requestDazTask(id.data.id, req.admin.userId, false));
  } catch (error) {
    return res
      .status(error instanceof RuntimeTaskError ? error.status : 503)
      .json({
        ok: false,
        error: "Task could not be retrieved. Its outcome is not yet confirmed.",
      });
  }
});

router.get("/daz-runtime/status", requireAdmin, async (req, res) => {
  try {
    const status = await readDazRuntimeStatus();
    res.setHeader("Cache-Control", "no-store");
    return res.json({
      ok: true,
      checked_at: new Date().toISOString(),
      reviewer: getAdminReviewer(req),
      request: { path: req.originalUrl || req.url, method: req.method },
      status,
    });
  } catch (error) {
    req.log?.warn({ error }, "Daz runtime status unavailable");
    return res
      .status(503)
      .json({ ok: false, error: "Daz runtime status unavailable." });
  }
});

export default router;
