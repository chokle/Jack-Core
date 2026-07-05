import { Router } from "express";
import {
  createAdminSession,
  clearAdminSession,
  isAdminSessionValid,
  getAdminReviewer,
  normalizeReviewer,
} from "../lib/admin-auth.js";

const router = Router();

router.post("/admin/login", (req, res) => {
  const body = req.body as Record<string, unknown>;
  const password = typeof body["password"] === "string" ? body["password"] : "";
  if (!password) {
    return res.status(400).json({ error: "password is required." });
  }

  // The reviewer name is the accountable human recorded behind every verify /
  // reject decision made during this session. It is optional at the auth layer
  // (a session is still valid without it), but the frontend requires it so a
  // "verified" concept always carries a name.
  const reviewer = normalizeReviewer(body["reviewer"]);

  const result = createAdminSession(password, res, reviewer);
  if (result === "unconfigured") {
    return res.status(503).json({ error: "Admin access is not configured." });
  }
  if (result === "wrong") {
    req.log.warn({ url: req.url }, "admin login failed — wrong password");
    return res.status(401).json({ error: "Incorrect password." });
  }
  return res.json({ ok: true, reviewer });
});

router.post("/admin/logout", (_req, res) => {
  clearAdminSession(res);
  return res.json({ ok: true });
});

router.get("/admin/session", (req, res) => {
  return res.json({
    authenticated: isAdminSessionValid(req),
    reviewer: getAdminReviewer(req),
  });
});

export default router;
