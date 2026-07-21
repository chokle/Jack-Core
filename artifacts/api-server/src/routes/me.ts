import { Router } from "express";
import { clerkClient } from "@clerk/express";
import {
  GetMeResponse,
  GetMemoryGraphOnboardingPreferenceResponse,
  UpdateMemoryGraphOnboardingPreferenceResponse,
  TrackMemoryGraphOnboardingEventResponse,
} from "@workspace/api-zod";
import { resolveIdentity } from "../lib/admin-auth.js";

const router = Router();

const ONBOARDING_VERSION = 1 as const;
const ONBOARDING_STATUSES = new Set(["completed", "skipped"]);
const ONBOARDING_EVENTS = new Set([
  "memory_onboarding_started",
  "memory_onboarding_step_viewed",
  "memory_onboarding_skipped",
  "memory_onboarding_completed",
  "memory_onboarding_reopened",
]);
const STEP_EVENTS = new Set([
  "memory_onboarding_step_viewed",
  "memory_onboarding_skipped",
  "memory_onboarding_completed",
]);

type OnboardingPreference = {
  version: typeof ONBOARDING_VERSION;
  status: "completed" | "skipped";
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function readPreference(value: unknown): OnboardingPreference | null {
  if (!isPlainObject(value) || !hasExactKeys(value, ["version", "status"])) return null;
  if (value["version"] !== ONBOARDING_VERSION) return null;
  if (typeof value["status"] !== "string" || !ONBOARDING_STATUSES.has(value["status"])) return null;
  return value as OnboardingPreference;
}

function readEvent(value: unknown): {
  event: string;
  source: "automatic" | "replay";
  version: typeof ONBOARDING_VERSION;
  step?: number;
} | null {
  if (!isPlainObject(value)) return null;
  const event = value["event"];
  const requiresStep = typeof event === "string" && STEP_EVENTS.has(event);
  if (!hasExactKeys(value, requiresStep ? ["event", "source", "version", "step"] : ["event", "source", "version"])) return null;
  if (typeof event !== "string" || !ONBOARDING_EVENTS.has(event)) return null;
  if (value["source"] !== "automatic" && value["source"] !== "replay") return null;
  if (value["version"] !== ONBOARDING_VERSION) return null;
  if (requiresStep && (!Number.isInteger(value["step"]) || Number(value["step"]) < 1 || Number(value["step"]) > 3)) return null;
  return {
    event,
    source: value["source"],
    version: ONBOARDING_VERSION,
    ...(requiresStep ? { step: Number(value["step"]) } : {}),
  };
}

function authenticatedUserId(req: { userId?: string }): string | null {
  return typeof req.userId === "string" && req.userId.length > 0 ? req.userId : null;
}

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

router.get("/me/preferences/memory-graph-onboarding", async (req, res) => {
  const userId = authenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized — sign in required." });

  try {
    const user = await clerkClient.users.getUser(userId);
    const preference = readPreference(user.privateMetadata?.["memoryGraphOnboarding"]);
    return res.json(GetMemoryGraphOnboardingPreferenceResponse.parse({ preference }));
  } catch (err) {
    req.log?.error({ err }, "failed to read Memory Graph onboarding preference");
    return res.status(503).json({ error: "Preference temporarily unavailable." });
  }
});

router.put("/me/preferences/memory-graph-onboarding", async (req, res) => {
  const userId = authenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized — sign in required." });

  const preference = readPreference(req.body);
  if (!preference) return res.status(400).json({ error: "Invalid onboarding preference." });

  try {
    await clerkClient.users.updateUserMetadata(userId, {
      privateMetadata: { memoryGraphOnboarding: preference },
    });
    return res.json(UpdateMemoryGraphOnboardingPreferenceResponse.parse({ preference }));
  } catch (err) {
    req.log?.error({ err }, "failed to write Memory Graph onboarding preference");
    return res.status(503).json({ error: "Preference temporarily unavailable." });
  }
});

router.post("/me/analytics/memory-graph-onboarding", (req, res) => {
  const userId = authenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized — sign in required." });

  const event = readEvent(req.body);
  if (!event) return res.status(400).json({ error: "Invalid onboarding event." });

  try {
    req.log?.info(
      {
        onboardingEvent: event.event,
        onboardingSource: event.source,
        onboardingVersion: event.version,
        ...(event.step === undefined ? {} : { onboardingStep: event.step }),
      },
      "Memory Graph onboarding event",
    );
  } catch {
    // Pilot analytics are best-effort and must never affect the user experience.
  }

  return res.status(202).json(TrackMemoryGraphOnboardingEventResponse.parse({ accepted: true }));
});

export default router;
