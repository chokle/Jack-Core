import { Router, type Request, type Response } from "express";
import crypto from "node:crypto";
import { supabase } from "../lib/supabase.js";
import {
  UUID_RE,
  hasOrganizationAuthority,
  isEligibleSiteMember,
  resolvedSiteCaller,
  resolveSiteScope,
} from "../lib/site-mapping-access.js";

const router = Router();
export const siteMappingCleanupRouter = Router();
const USER_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_SCAN_BYTES = 25 * 1024 * 1024;

function workerOnly(req: Request): boolean {
  const configured = process.env["RADAR_WORKER_TOKEN"];
  const supplied = req.get("x-jack-radar-worker-token");
  if (
    !configured ||
    configured.length < 32 ||
    !supplied ||
    supplied.length !== configured.length
  )
    return false;
  return crypto.timingSafeEqual(Buffer.from(configured), Buffer.from(supplied));
}

function failed(req: Request, res: Response, err: unknown) {
  req.log.error({ err }, "site mapping request failed");
  return res
    .status(500)
    .json({ error: "Site mapping is temporarily unavailable." });
}

router.get("/site-mapping/organizations", async (req, res) => {
  try {
    const caller = await resolvedSiteCaller(req);
    if (!caller)
      return res
        .status(403)
        .json({ error: "Site access requires a resolved account." });
    const memberships = await supabase
      .from("pilot_memberships")
      .select("organization_id")
      .eq("user_id", caller.userId)
      .eq("role", "organization_admin")
      .is("pilot_id", null)
      .eq("active", true);
    if (memberships.error) throw memberships.error;
    const ids = [
      ...new Set(
        (memberships.data ?? []).map((row) => row.organization_id as string),
      ),
    ];
    if (!ids.length) return res.json({ organizations: [] });
    const organizations = await supabase
      .from("organizations")
      .select("id,name,status")
      .in("id", ids)
      .eq("status", "active")
      .order("name");
    if (organizations.error) throw organizations.error;
    // Candidate memberships still need their validity windows checked.
    const authorized = await Promise.all(
      (organizations.data ?? []).map(async (org) =>
        (await hasOrganizationAuthority(caller.userId, org.id))
          ? { id: org.id, name: org.name }
          : null,
      ),
    );
    return res.json({
      organizations: authorized.filter((org) => org !== null),
    });
  } catch (err) {
    return failed(req, res, err);
  }
});

router.get("/site-mapping/sites", async (req, res) => {
  try {
    const caller = await resolvedSiteCaller(req);
    if (!caller)
      return res
        .status(403)
        .json({ error: "Site access requires a resolved account." });
    const memberships = await supabase
      .from("site_memberships")
      .select("site_id,organization_id,role")
      .eq("user_id", caller.userId)
      .eq("active", true);
    if (memberships.error) throw memberships.error;
    const ids = (memberships.data ?? []).map((row) => row.site_id as string);
    if (!ids.length) return res.json({ sites: [] });
    const sites = await supabase
      .from("site_workspaces")
      .select("id,organization_id,name,status")
      .in("id", ids)
      .order("name");
    if (sites.error) throw sites.error;
    const authorized = await Promise.all(
      (sites.data ?? []).map(async (site) => {
        const scope = await resolveSiteScope(caller.userId, site.id);
        return scope && scope.organizationId === site.organization_id
          ? { ...site, role: scope.role }
          : null;
      }),
    );
    return res.json({ sites: authorized.filter((site) => site !== null) });
  } catch (err) {
    return failed(req, res, err);
  }
});

router.post("/site-mapping/sites", async (req, res) => {
  try {
    const caller = await resolvedSiteCaller(req);
    if (!caller)
      return res
        .status(403)
        .json({ error: "Site creation requires a resolved account." });
    const organizationId = req.body?.organizationId;
    const name = req.body?.name;
    if (
      typeof organizationId !== "string" ||
      !UUID_RE.test(organizationId) ||
      typeof name !== "string" ||
      !name.trim() ||
      name.trim().length > 160
    )
      return res
        .status(400)
        .json({ error: "Invalid site name or organization." });
    if (!(await hasOrganizationAuthority(caller.userId, organizationId)))
      return res
        .status(403)
        .json({ error: "Organization site access denied." });
    const siteId = crypto.randomUUID();
    const created = await supabase
      .from("site_workspaces")
      .insert({
        id: siteId,
        organization_id: organizationId,
        name: name.trim(),
        created_by_user_id: caller.userId,
      })
      .select("id,organization_id,name,status")
      .single();
    if (created.error) throw created.error;
    const membership = await supabase.from("site_memberships").insert({
      organization_id: organizationId,
      site_id: siteId,
      user_id: caller.userId,
      role: "manager",
      added_by_user_id: caller.userId,
    });
    if (membership.error) {
      const rollback = await supabase
        .from("site_workspaces")
        .delete()
        .eq("id", siteId)
        .eq("organization_id", organizationId);
      if (rollback.error)
        req.log.error(
          { err: rollback.error, siteId },
          "site creation rollback failed",
        );
      throw membership.error;
    }
    return res.status(201).json({ site: { ...created.data, role: "manager" } });
  } catch (err) {
    return failed(req, res, err);
  }
});

router.get("/site-mapping/sites/:siteId/scans", async (req, res) => {
  try {
    const caller = await resolvedSiteCaller(req);
    if (!caller)
      return res
        .status(403)
        .json({ error: "Site access requires a resolved account." });
    const scope = await resolveSiteScope(
      caller.userId,
      String(req.params.siteId),
    );
    if (!scope) return res.status(404).json({ error: "Site not found." });
    const scans = await supabase
      .from("site_scans")
      .select(
        "id,capture_format,status,byte_size,point_count,created_at,uploaded_at",
      )
      .eq("site_id", scope.siteId)
      .eq("organization_id", scope.organizationId)
      .eq("status", "uploaded")
      .order("created_at", { ascending: false })
      .limit(100);
    if (scans.error) throw scans.error;
    return res.json({
      site: scope,
      scans: scans.data ?? [],
      mapStatus: "No reviewed site map published",
    });
  } catch (err) {
    return failed(req, res, err);
  }
});

router.get("/site-mapping/sites/:siteId/upload-access", async (req, res) => {
  try {
    const caller = await resolvedSiteCaller(req);
    if (!caller)
      return res
        .status(403)
        .json({ error: "Site access requires a resolved account." });
    const scope = await resolveSiteScope(
      caller.userId,
      String(req.params.siteId),
    );
    if (!scope || scope.status !== "active" || scope.role === "viewer")
      return res.status(404).json({ error: "Site not found." });
    return res.status(204).end();
  } catch (err) {
    return failed(req, res, err);
  }
});

router.put("/site-mapping/sites/:siteId/members/:userId", async (req, res) => {
  try {
    const caller = await resolvedSiteCaller(req);
    if (!caller)
      return res
        .status(403)
        .json({ error: "Site access requires a resolved account." });
    const scope = await resolveSiteScope(
      caller.userId,
      String(req.params.siteId),
    );
    if (!scope || scope.role !== "manager" || scope.status !== "active")
      return res.status(404).json({ error: "Site not found." });
    const userId = String(req.params.userId);
    const role = req.body?.role;
    if (!USER_ID_RE.test(userId) || !["contributor", "viewer"].includes(role))
      return res.status(400).json({ error: "Invalid site member or role." });
    if (!(await isEligibleSiteMember(userId, scope.organizationId)))
      return res
        .status(400)
        .json({ error: "The member is not active in this organization." });
    const membership = await supabase.from("site_memberships").upsert(
      {
        organization_id: scope.organizationId,
        site_id: scope.siteId,
        user_id: userId,
        role,
        active: true,
        added_by_user_id: caller.userId,
      },
      { onConflict: "site_id,user_id" },
    );
    if (membership.error) throw membership.error;
    return res.json({ userId, role });
  } catch (err) {
    return failed(req, res, err);
  }
});

router.delete(
  "/site-mapping/sites/:siteId/members/:userId",
  async (req, res) => {
    try {
      const caller = await resolvedSiteCaller(req);
      if (!caller)
        return res
          .status(403)
          .json({ error: "Site access requires a resolved account." });
      const scope = await resolveSiteScope(
        caller.userId,
        String(req.params.siteId),
      );
      if (!scope || scope.role !== "manager")
        return res.status(404).json({ error: "Site not found." });
      const userId = String(req.params.userId);
      if (!USER_ID_RE.test(userId) || userId === caller.userId)
        return res.status(400).json({ error: "Invalid member removal." });
      const result = await supabase
        .from("site_memberships")
        .update({ active: false })
        .eq("site_id", scope.siteId)
        .eq("organization_id", scope.organizationId)
        .eq("user_id", userId)
        .neq("role", "manager");
      if (result.error) throw result.error;
      return res.status(204).end();
    } catch (err) {
      return failed(req, res, err);
    }
  },
);

// The Worker validates the PLY and computes its hash before calling this route.
// The token ensures browsers cannot invent completed scans or request object keys.
router.post(
  "/site-mapping/internal/sites/:siteId/scans/authorize",
  async (req, res) => {
    if (!workerOnly(req)) return res.status(403).json({ error: "Forbidden." });
    try {
      const caller = await resolvedSiteCaller(req);
      if (!caller)
        return res
          .status(403)
          .json({ error: "Site access requires a resolved account." });
      const scope = await resolveSiteScope(
        caller.userId,
        String(req.params.siteId),
      );
      if (!scope || scope.status !== "active" || scope.role === "viewer")
        return res.status(404).json({ error: "Site not found." });
      const { byteSize, pointCount, sha256 } = req.body ?? {};
      if (
        !Number.isInteger(byteSize) ||
        byteSize < 1 ||
        byteSize > MAX_SCAN_BYTES ||
        !Number.isInteger(pointCount) ||
        pointCount < 1 ||
        pointCount > 2_000_000 ||
        typeof sha256 !== "string" ||
        !SHA256_RE.test(sha256)
      )
        return res.status(400).json({ error: "Invalid scan metadata." });
      const scanId = crypto.randomUUID();
      const objectKey = `organizations/${scope.organizationId}/sites/${scope.siteId}/scans/${scanId}.ply`;
      const inserted = await supabase.from("site_scans").insert({
        id: scanId,
        organization_id: scope.organizationId,
        site_id: scope.siteId,
        uploaded_by_user_id: caller.userId,
        object_key: objectKey,
        capture_format: "radar_ply_points_v1",
        byte_size: byteSize,
        point_count: pointCount,
        sha256,
      });
      if (inserted.error) throw inserted.error;
      return res.status(201).json({ scanId, objectKey });
    } catch (err) {
      return failed(req, res, err);
    }
  },
);

router.post(
  "/site-mapping/internal/sites/:siteId/scans/:scanId/complete",
  async (req, res) => {
    if (!workerOnly(req)) return res.status(403).json({ error: "Forbidden." });
    try {
      const caller = await resolvedSiteCaller(req);
      if (!caller)
        return res
          .status(403)
          .json({ error: "Site access requires a resolved account." });
      const scope = await resolveSiteScope(
        caller.userId,
        String(req.params.siteId),
      );
      const scanId = String(req.params.scanId);
      if (!scope || !UUID_RE.test(scanId) || scope.status !== "active")
        return res.status(404).json({ error: "Site not found." });
      const existing = await supabase
        .from("site_scans")
        .select("id,status,byte_size,point_count,uploaded_at")
        .eq("id", scanId)
        .eq("site_id", scope.siteId)
        .eq("organization_id", scope.organizationId)
        .eq("uploaded_by_user_id", caller.userId)
        .maybeSingle();
      if (existing.error) throw existing.error;
      if (!existing.data)
        return res.status(404).json({ error: "Scan not found." });
      if (existing.data.status === "uploaded")
        return res.json({ scan: existing.data });
      if (existing.data.status !== "pending")
        return res.status(409).json({ error: "Scan cannot be completed." });
      const result = await supabase
        .from("site_scans")
        .update({ status: "uploaded", uploaded_at: new Date().toISOString() })
        .eq("id", scanId)
        .eq("site_id", scope.siteId)
        .eq("organization_id", scope.organizationId)
        .eq("uploaded_by_user_id", caller.userId)
        .eq("status", "pending")
        .select("id,byte_size,point_count,uploaded_at")
        .maybeSingle();
      if (result.error) throw result.error;
      if (!result.data)
        return res
          .status(409)
          .json({ error: "Scan completion changed. Retry safely." });
      return res.json({ scan: result.data });
    } catch (err) {
      return failed(req, res, err);
    }
  },
);

router.get(
  "/site-mapping/internal/sites/:siteId/scans/:scanId/download",
  async (req, res) => {
    if (!workerOnly(req)) return res.status(403).json({ error: "Forbidden." });
    try {
      const caller = await resolvedSiteCaller(req);
      if (!caller)
        return res
          .status(403)
          .json({ error: "Site access requires a resolved account." });
      const scope = await resolveSiteScope(
        caller.userId,
        String(req.params.siteId),
      );
      const scanId = String(req.params.scanId);
      if (!scope || !UUID_RE.test(scanId))
        return res.status(404).json({ error: "Scan not found." });
      const scan = await supabase
        .from("site_scans")
        .select("object_key,byte_size,sha256")
        .eq("id", scanId)
        .eq("site_id", scope.siteId)
        .eq("organization_id", scope.organizationId)
        .eq("status", "uploaded")
        .maybeSingle();
      if (scan.error) throw scan.error;
      if (!scan.data) return res.status(404).json({ error: "Scan not found." });
      return res.json({
        objectKey: scan.data.object_key,
        byteSize: scan.data.byte_size,
        sha256: scan.data.sha256,
      });
    } catch (err) {
      return failed(req, res, err);
    }
  },
);

// The hourly Worker job claims stale pending rows before deleting R2 bytes.
// A conditional transition prevents a late completion from publishing a scan
// while its object is being removed. Deleting rows remain retryable.
siteMappingCleanupRouter.post(
  "/site-mapping/internal/scans/cleanup/claim",
  async (req, res) => {
    if (!workerOnly(req)) return res.status(403).json({ error: "Forbidden." });
    try {
      const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const candidates = await supabase
        .from("site_scans")
        .select("id,object_key,status")
        .in("status", ["pending", "deleting"])
        .lt("created_at", cutoff)
        .order("created_at")
        .limit(100);
      if (candidates.error) throw candidates.error;
      const scans: Array<{ id: string; objectKey: string }> = [];
      for (const candidate of candidates.data ?? []) {
        if (candidate.status === "deleting") {
          scans.push({ id: candidate.id, objectKey: candidate.object_key });
          continue;
        }
        const claimed = await supabase
          .from("site_scans")
          .update({ status: "deleting" })
          .eq("id", candidate.id)
          .eq("status", "pending")
          .select("id,object_key")
          .maybeSingle();
        if (claimed.error) throw claimed.error;
        if (claimed.data)
          scans.push({
            id: claimed.data.id,
            objectKey: claimed.data.object_key,
          });
      }
      return res.json({ scans });
    } catch (err) {
      return failed(req, res, err);
    }
  },
);

siteMappingCleanupRouter.delete(
  "/site-mapping/internal/scans/:scanId/cleanup",
  async (req, res) => {
    if (!workerOnly(req)) return res.status(403).json({ error: "Forbidden." });
    try {
      const scanId = String(req.params.scanId);
      if (!UUID_RE.test(scanId))
        return res.status(400).json({ error: "Invalid scan." });
      const result = await supabase
        .from("site_scans")
        .delete()
        .eq("id", scanId)
        .eq("status", "deleting");
      if (result.error) throw result.error;
      return res.status(204).end();
    } catch (err) {
      return failed(req, res, err);
    }
  },
);

export default router;
