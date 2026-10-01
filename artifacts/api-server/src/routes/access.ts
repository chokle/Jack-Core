import { Router, type Request, type Response } from "express";
import { clerkClient } from "@clerk/express";
import { rateLimit } from "express-rate-limit";
import { CreateJackInvitationBody } from "@workspace/api-zod";
import { resolveIdentity } from "../lib/admin-auth.js";
import {
  inviteOrganizations,
  isJackAccountDeleted,
  jackAccessContext,
} from "../lib/jack-access.js";
import { supabase } from "../lib/supabase.js";

const router = Router();
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const inviteLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => req.userId ?? "unauthenticated",
  message: { error: "Too many invitations. Please try again later." },
});
const acceptLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => req.userId ?? "unauthenticated",
  message: { error: "Please wait a moment before trying again." },
});
type InvitationRow = {
  id: string;
  organization_id: string;
  email: string | null;
  role: string;
  status: string;
  delivery_status: string;
  expires_at: string;
  invited_by_user_id: string | null;
};
const receipt = (row: InvitationRow) => ({
  id: row.id,
  organizationId: row.organization_id,
  email: row.email ?? "Deleted account",
  role: row.role,
  status: row.status,
  deliveryStatus: row.delivery_status,
  expiresAt: row.expires_at,
});
const fail = (req: Request, res: Response, err: unknown) => {
  req.log?.error(
    { errorType: err instanceof Error ? err.name : "database_error" },
    "Jack access request failed",
  );
  return res
    .status(503)
    .json({ error: "Access is temporarily unavailable. Please try again." });
};
router.use("/access", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  if (!req.userId) {
    res.status(401).json({ error: "Sign in required." });
    return;
  }
  next();
});
router.get("/access", async (req, res) => {
  try {
    return res.json(await jackAccessContext(req));
  } catch (err) {
    return fail(req, res, err);
  }
});
router.post("/access/accept", acceptLimiter, async (req, res) => {
  try {
    const user = await clerkClient.users.getUser(req.userId!);
    const verifiedEmails = new Set(
      user.emailAddresses
        .filter((email) => email.verification?.status === "verified")
        .map((email) => email.emailAddress.trim().toLowerCase()),
    );
    for (const email of verifiedEmails) {
      const result = await supabase.rpc("accept_jack_invitations", {
        p_user_id: req.userId!,
        p_email: email,
      });
      if (result.error) throw result.error;
    }
    return res.json(await jackAccessContext(req));
  } catch (err) {
    return fail(req, res, err);
  }
});
router.get("/access/organizations", async (req, res) => {
  try {
    const caller = await resolveIdentity(req);
    if (
      !caller ||
      caller.classification !== "resolved" ||
      caller.isPresentation
    )
      return res
        .status(403)
        .json({ error: "Invitation admin access required." });
    return res.json({ organizations: await inviteOrganizations(caller) });
  } catch (err) {
    return fail(req, res, err);
  }
});
router.get("/access/invitations", async (req, res) => {
  const organizationId = String(req.query.organizationId ?? "");
  if (!UUID_RE.test(organizationId))
    return res.status(400).json({ error: "Choose an organization." });
  try {
    const caller = await resolveIdentity(req);
    if (
      !caller ||
      !(await inviteOrganizations(caller)).some(
        (org) => org.id === organizationId,
      )
    )
      return res
        .status(403)
        .json({ error: "Organization admin access required." });
    const result = await supabase
      .from("jack_access_invitations")
      .select("*")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .limit(100);
    if (result.error) throw result.error;
    return res.json({
      invitations: (result.data ?? []).map((row) =>
        receipt(row as InvitationRow),
      ),
    });
  } catch (err) {
    return fail(req, res, err);
  }
});
router.post("/access/invitations", inviteLimiter, async (req, res) => {
  const parsed = CreateJackInvitationBody.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({
      error: "Provide an email, organization, and member or champion role.",
    });
  const { requestId, organizationId, role } = parsed.data;
  const email = parsed.data.email.trim().toLowerCase();
  try {
    const caller = await resolveIdentity(req);
    if (
      !caller ||
      !(await inviteOrganizations(caller)).some(
        (org) => org.id === organizationId,
      )
    )
      return res
        .status(403)
        .json({ error: "Organization admin access required." });
    const previous = await supabase
      .from("jack_access_invitations")
      .select("*")
      .eq("id", requestId)
      .maybeSingle();
    if (previous.error) throw previous.error;
    if (previous.data) {
      const row = previous.data as InvitationRow;
      if (
        row.organization_id !== organizationId ||
        row.email !== email ||
        row.role !== role ||
        row.invited_by_user_id !== caller.userId
      )
        return res.status(409).json({
          error: "This request ID belongs to a different invitation.",
        });
      return res.json(receipt(row));
    }
    const created = await supabase
      .from("jack_access_invitations")
      .insert({
        id: requestId,
        organization_id: organizationId,
        email,
        role,
        invited_by_user_id: caller.userId,
      })
      .select("*")
      .single();
    if (created.error?.code === "23505")
      return res.status(409).json({
        error:
          "An invitation is already pending. Review or revoke it before inviting again.",
      });
    if (created.error || !created.data)
      throw created.error ?? new Error("Invitation not persisted");
    // Persist intent before sending. A repeated request returns its receipt and
    // never duplicates an email whose delivery outcome is unknown.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      const invitation = await Promise.race([
        (async () => {
          const users = await clerkClient.users.getUserList({
            emailAddress: [email],
            limit: 2,
          });
          if (timedOut || users.data.length > 1)
            throw new Error("Account provisioning not confirmed");
          let user = users.data[0];
          if (!user) {
            // The Backend API supports reserved identifiers. SDK 3.10 passes
            // params through but predates this optional field in its types.
            // Reserve the address; only the recipient's OTP verifies it.
            const provisioning = {
              emailAddress: [email],
              skipPasswordRequirement: true,
              emailAddressIdentificationStatus: ["reserved"],
            };
            user = await clerkClient.users.createUser(provisioning);
          }
          if (timedOut) throw new Error("Account provisioning timed out");
          const bound = await supabase
            .from("jack_access_invitations")
            .update({
              clerk_user_id: user.id,
              invited_by_user_id: caller.userId,
            })
            .eq("id", requestId)
            .eq("status", "pending")
            .select("*")
            .single();
          if (bound.error || !bound.data)
            throw bound.error ?? new Error("Invitation is no longer pending");
          if (
            (await isJackAccountDeleted(caller.userId)) ||
            (await isJackAccountDeleted(user.id))
          )
            throw new Error("Account deletion prevents invitation delivery");
          if (timedOut) throw new Error("Account provisioning timed out");
          return clerkClient.invitations.createInvitation({
            emailAddress: email,
            ignoreExisting: true,
            notify: true,
            expiresInDays: 7,
            redirectUrl: "https://jack.torchlabs.ca/sign-in",
            publicMetadata: { jackAccessInvitationId: requestId },
          });
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new Error("Invitation delivery timeout"));
          }, 15_000);
        }),
      ]);
      const delivered = await supabase
        .from("jack_access_invitations")
        .update({
          clerk_invitation_id: invitation.id,
          delivery_status: "sent",
          invited_by_user_id: caller.userId,
        })
        .eq("id", requestId)
        .select("*")
        .single();
      if (delivered.error || !delivered.data)
        throw delivered.error ?? new Error("Delivery receipt unavailable");
      return res.status(201).json(receipt(delivered.data as InvitationRow));
    } catch {
      const uncertain = await supabase
        .from("jack_access_invitations")
        .update({
          delivery_status: "unknown",
          invited_by_user_id: caller.userId,
        })
        .eq("id", requestId)
        .select("*")
        .single();
      if (uncertain.error || !uncertain.data)
        throw uncertain.error ?? new Error("Invitation receipt unavailable");
      req.log?.warn(
        { invitationId: requestId },
        "Invitation email delivery is unconfirmed; do not resend this request",
      );
      return res.status(202).json(receipt(uncertain.data as InvitationRow));
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch (err) {
    return fail(req, res, err);
  }
});
router.delete("/access/invitations/:id", inviteLimiter, async (req, res) => {
  const id = String(req.params.id);
  if (!UUID_RE.test(id))
    return res.status(400).json({ error: "Invalid invitation." });
  try {
    const caller = await resolveIdentity(req);
    if (!caller)
      return res
        .status(403)
        .json({ error: "Organization admin access required." });
    const row = await supabase
      .from("jack_access_invitations")
      .select("organization_id")
      .eq("id", id)
      .maybeSingle();
    if (row.error) throw row.error;
    if (
      !row.data ||
      !(await inviteOrganizations(caller)).some(
        (org) => org.id === row.data?.organization_id,
      )
    )
      return res.status(404).json({ error: "Invitation not found." });
    const result = await supabase.rpc("revoke_jack_invitation", {
      p_invitation_id: id,
      p_actor_user_id: caller.userId,
    });
    if (result.error) throw result.error;
    return res.status(204).send();
  } catch (err) {
    return fail(req, res, err);
  }
});
export default router;
