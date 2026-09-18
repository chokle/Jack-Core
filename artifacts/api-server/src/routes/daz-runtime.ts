import { Router } from "express";
import { requireAdmin } from "../lib/admin-auth.js";
import { readDazRuntimeStatus } from "../lib/daz-runtime.js";

const router = Router();

router.get("/daz-runtime/status", requireAdmin, async (req, res) => {
  try {
    const status = await readDazRuntimeStatus();
    res.setHeader("Cache-Control", "no-store");
    return res.json({ ok: true, status });
  } catch (error) {
    req.log?.warn({ error }, "Daz runtime status unavailable");
    return res.status(503).json({ ok: false, error: "Daz runtime status unavailable." });
  }
});

export default router;
