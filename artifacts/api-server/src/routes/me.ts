import { Router } from "express";
import { GetMeResponse } from "@workspace/api-zod";
import { resolveIdentity } from "../lib/admin-auth.js";

const router = Router();

// "Who am I": the signed-in caller's identity and whether they are an admin.
// Sits behind the app-level requireAuth gate, so an unauthenticated request
// 401s before reaching here. The frontend uses `isAdmin` to gate admin-only UI,
// but the server still enforces admin access independently on every admin route
// (requireAdmin) — hiding UI is defense-in-depth, not the security boundary.
router.get("/me", async (req, res) => {
  const identity = await resolveIdentity(req);
  if (!identity) {
    return res.status(401).json({ error: "Unauthorized — sign in required." });
  }
  return res.json(
    GetMeResponse.parse({
      userId: identity.userId,
      email: identity.email,
      name: identity.name,
      isAdmin: identity.isAdmin,
    }),
  );
});

export default router;
