import { Router } from "express";

const router = Router();
// An email alone is not proof of ownership, even on a historical pilot list.
router.post("/", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  return res
    .status(410)
    .json({
      error: "Sign in with the email code at /sign-in.",
      signInUrl: "/sign-in",
    });
});
export default router;
