import { URL } from "node:url";
import { Router, type Request, type Response } from "express";
import { clerkClient } from "@clerk/express";
import { resolveActiveTesterScope } from "../lib/activity-telemetry.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EXPIRES_IN_SECONDS = 900;
const REDIRECT_DEFAULT = "https://jack.torchlabs.ca/app";

function canonicalEmail(value: string): string {
  return value.trim().toLowerCase();
}

function parseAllowedEmails(): Set<string> {
  const configured = process.env["PILOT_DIRECT_ACCESS_EMAILS"];
  if (!configured) return new Set<string>();
  return new Set(
    configured
      .split(",")
      .map((entry) => canonicalEmail(entry))
      .filter(Boolean),
  );
}

function redirectUrl(): string {
  const configured = process.env["PILOT_DIRECT_ACCESS_REDIRECT"]?.trim();
  if (!configured) return REDIRECT_DEFAULT;
  try {
    const parsed = new URL(configured);
    if (!/^https:/.test(parsed.protocol)) return REDIRECT_DEFAULT;
    return parsed.href;
  } catch {
    return REDIRECT_DEFAULT;
  }
}

function mapAllowlistError(rawEmail: string): string {
  return `The identifier ${rawEmail} is not configured for direct pilot sign-in.`;
}

const router = Router();

router.post("/", async (req: Request, res: Response) => {
  const bodyEmail = canonicalEmail(String(req.body?.email ?? ""));
  const bodyIdentifier = canonicalEmail(String(req.body?.identifier ?? ""));
  const identifier = bodyIdentifier || bodyEmail;

  if (!identifier || !EMAIL_RE.test(identifier)) {
    return res
      .status(400)
      .json({ error: "Please provide a valid pilot email address." });
  }

  const allowedEmails = parseAllowedEmails();
  if (allowedEmails.size > 0 && !allowedEmails.has(identifier)) {
    return res.status(403).json({ error: mapAllowlistError(identifier) });
  }

  try {
    const users = await clerkClient.users.getUserList({
      emailAddress: [identifier],
      limit: 2,
    });
    const user = users.data?.[0];
    if (!user?.id) {
      return res.status(403).json({
        error:
          "Direct sign-in could not be completed. Contact a pilot admin for approval.",
      });
    }

    const membershipScope = await resolveActiveTesterScope(user.id);
    if (!membershipScope.scope) {
      req.log?.warn(
        { userId: user.id, email: identifier, reason: membershipScope.reason },
        "direct pilot sign-in denied: no active membership",
      );
      return res.status(403).json({
        error:
          "Direct sign-in could not be completed. Contact a pilot admin for approval.",
      });
    }

    const token = await clerkClient.signInTokens.createSignInToken({
      userId: user.id,
      expiresInSeconds: EXPIRES_IN_SECONDS,
    });
    const enrollmentUrl = new URL(token.url);
    enrollmentUrl.searchParams.set("redirect_url", redirectUrl());

    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.status(200).json({
      userId: user.id,
      pilotId: membershipScope.scope.pilotId,
      organizationId: membershipScope.scope.organizationId,
      url: enrollmentUrl.toString(),
    });
  } catch (error) {
    req.log?.error({ error, email: identifier }, "direct pilot sign-in failed");
    return res.status(503).json({ error: "Direct sign-in is temporarily unavailable." });
  }
});

export default router;
