import type { Request } from "express";
import { resolveIdentity, type CallerIdentity } from "./admin-auth.js";
import { supabase } from "./supabase.js";

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface SiteScope {
  siteId: string;
  organizationId: string;
  name: string;
  status: "active" | "archived";
  role: "manager" | "contributor" | "viewer";
}

export async function resolvedSiteCaller(
  req: Request,
): Promise<CallerIdentity | null> {
  const identity = await resolveIdentity(req);
  return identity?.classification === "resolved" && !identity.isPresentation
    ? identity
    : null;
}

function currentMembership(row: {
  active?: boolean;
  valid_from?: string | null;
  valid_until?: string | null;
}): boolean {
  const now = Date.now();
  const from = row.valid_from
    ? Date.parse(row.valid_from)
    : Number.NEGATIVE_INFINITY;
  const until = row.valid_until
    ? Date.parse(row.valid_until)
    : Number.POSITIVE_INFINITY;
  return row.active === true && from <= now && now < until;
}

/** An organization admin can open a site only inside their own active organization. */
export async function hasOrganizationAuthority(
  userId: string,
  organizationId: string,
): Promise<boolean> {
  if (!UUID_RE.test(organizationId)) return false;
  const organization = await supabase
    .from("organizations")
    .select("id,status")
    .eq("id", organizationId)
    .maybeSingle();
  if (organization.error) throw organization.error;
  if (organization.data?.status !== "active") return false;
  const membership = await supabase
    .from("pilot_memberships")
    .select("active,valid_from,valid_until")
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .eq("role", "organization_admin")
    .is("pilot_id", null)
    .eq("active", true)
    .maybeSingle();
  if (membership.error) throw membership.error;
  return !!membership.data && currentMembership(membership.data);
}

/** The tenant and site are both checked server-side; client IDs carry no authority. */
export async function resolveSiteScope(
  userId: string,
  siteId: string,
): Promise<SiteScope | null> {
  if (!UUID_RE.test(siteId)) return null;
  const site = await supabase
    .from("site_workspaces")
    .select("id,organization_id,name,status")
    .eq("id", siteId)
    .maybeSingle();
  if (site.error) throw site.error;
  if (
    !site.data ||
    (site.data.status !== "active" && site.data.status !== "archived")
  )
    return null;
  const organization = await supabase
    .from("organizations")
    .select("status")
    .eq("id", site.data.organization_id)
    .maybeSingle();
  if (organization.error) throw organization.error;
  if (organization.data?.status !== "active") return null;
  const membership = await supabase
    .from("site_memberships")
    .select("organization_id,role,active")
    .eq("site_id", siteId)
    .eq("user_id", userId)
    .eq("active", true)
    .maybeSingle();
  if (membership.error) throw membership.error;
  if (
    !membership.data ||
    membership.data.organization_id !== site.data.organization_id
  )
    return null;
  if (!["manager", "contributor", "viewer"].includes(membership.data.role))
    return null;
  if (!(await isEligibleSiteMember(userId, site.data.organization_id)))
    return null;
  return {
    siteId: site.data.id,
    organizationId: site.data.organization_id,
    name: site.data.name,
    status: site.data.status as SiteScope["status"],
    role: membership.data.role as SiteScope["role"],
  };
}

/** Members must already belong to an active pilot in the same organization. */
export async function isEligibleSiteMember(
  userId: string,
  organizationId: string,
): Promise<boolean> {
  const result = await supabase
    .from("pilot_memberships")
    .select("role,pilot_id,active,valid_from,valid_until")
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .eq("active", true);
  if (result.error) throw result.error;
  const current = (result.data ?? []).filter(currentMembership);
  if (current.some((row) => row.role === "organization_admin" && !row.pilot_id))
    return true;
  const pilotIds = current
    .map((row) => row.pilot_id)
    .filter((id): id is string => !!id);
  if (!pilotIds.length) return false;
  const pilots = await supabase
    .from("pilots")
    .select("id,status")
    .eq("organization_id", organizationId)
    .in("id", pilotIds)
    .eq("status", "active");
  if (pilots.error) throw pilots.error;
  return (pilots.data ?? []).length > 0;
}
