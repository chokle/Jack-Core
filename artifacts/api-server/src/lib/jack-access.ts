import type { Request } from "express";
import { createHash } from "node:crypto";
import { resolveIdentity, type CallerIdentity } from "./admin-auth.js";
import { supabase } from "./supabase.js";

export type JackRole =
  | "member"
  | "champion"
  | "organization_admin"
  | "tester"
  | "pilot_admin";
export interface JackOrganization {
  id: string;
  name: string;
  role: JackRole;
}
export interface JackAccessContext {
  allowed: boolean;
  organizations: JackOrganization[];
  canInvite: boolean;
}
/** Same SHA-256 subject fence as the trusted account-deletion RPC. */
export async function isJackAccountDeleted(userId: string): Promise<boolean> {
  const result = await supabase
    .from("jack_access_deleted_accounts")
    .select("subject_hash")
    .eq("subject_hash", createHash("sha256").update(userId).digest("hex"))
    .maybeSingle();
  if (result.error) throw result.error;
  return !!result.data;
}
function currentWindow(row: {
  active: boolean;
  valid_from?: string | null;
  valid_until?: string | null;
}): boolean {
  const from = row.valid_from
    ? Date.parse(row.valid_from)
    : Number.NEGATIVE_INFINITY;
  const until = row.valid_until
    ? Date.parse(row.valid_until)
    : Number.POSITIVE_INFINITY;
  return row.active === true && from <= Date.now() && Date.now() < until;
}
/** Actual current tenant membership, without cohort, email, or device allowlists. */
export async function resolveJackOrganizations(
  userId: string,
): Promise<JackOrganization[]> {
  if (await isJackAccountDeleted(userId)) return [];
  const [general, legacy] = await Promise.all([
    supabase
      .from("jack_memberships")
      .select("organization_id,role,active")
      .eq("user_id", userId)
      .eq("active", true),
    supabase
      .from("pilot_memberships")
      .select("organization_id,pilot_id,role,active,valid_from,valid_until")
      .eq("user_id", userId)
      .eq("active", true),
  ]);
  if (general.error) throw general.error;
  if (legacy.error) throw legacy.error;
  const current = (legacy.data ?? []).filter(currentWindow);
  const pilotIds = current.flatMap((row) =>
    row.pilot_id ? [row.pilot_id as string] : [],
  );
  const pilots = pilotIds.length
    ? await supabase
        .from("pilots")
        .select("id,organization_id")
        .in("id", pilotIds)
        .eq("status", "active")
    : { data: [], error: null };
  if (pilots.error) throw pilots.error;
  const candidates = [
    ...(general.data ?? []).filter(
      (row) => row.active && (row.role === "member" || row.role === "champion"),
    ),
    ...current.filter(
      (row) =>
        (row.role === "organization_admin" && !row.pilot_id) ||
        (["tester", "pilot_admin"].includes(row.role) &&
          (pilots.data ?? []).some(
            (pilot: { id: string; organization_id: string }) =>
              pilot.id === row.pilot_id &&
              pilot.organization_id === row.organization_id,
          )),
    ),
  ];
  const ids = [
    ...new Set(candidates.map((row) => row.organization_id as string)),
  ];
  if (!ids.length) return [];
  const organizations = await supabase
    .from("organizations")
    .select("id,name")
    .in("id", ids)
    .eq("status", "active")
    .order("name");
  if (organizations.error) throw organizations.error;
  const priority: Record<JackRole, number> = {
    member: 0,
    champion: 1,
    tester: 2,
    pilot_admin: 3,
    organization_admin: 4,
  };
  return (organizations.data ?? []).map((org) => {
    const roles = candidates
      .filter((row) => row.organization_id === org.id)
      .map((row) => row.role as JackRole);
    roles.sort((a, b) => priority[b] - priority[a]);
    return { id: org.id, name: org.name, role: roles[0]! };
  });
}
export async function jackAccessContext(
  req: Request,
): Promise<JackAccessContext> {
  const caller = await resolveIdentity(req);
  if (
    !caller ||
    caller.classification !== "resolved" ||
    caller.isPresentation ||
    (await isJackAccountDeleted(caller.userId))
  )
    return { allowed: false, organizations: [], canInvite: false };
  const organizations = await resolveJackOrganizations(caller.userId);
  return {
    allowed: caller.isAdmin || organizations.length > 0,
    organizations,
    canInvite:
      caller.isAdmin ||
      organizations.some((org) => org.role === "organization_admin"),
  };
}
/** Platform admins administer active tenants; tenant admins only their own. */
export async function inviteOrganizations(
  caller: CallerIdentity,
): Promise<Array<{ id: string; name: string }>> {
  if (caller.classification !== "resolved" || caller.isPresentation) return [];
  if (await isJackAccountDeleted(caller.userId)) return [];
  if (caller.isAdmin) {
    const result = await supabase
      .from("organizations")
      .select("id,name")
      .eq("status", "active")
      .order("name");
    if (result.error) throw result.error;
    return result.data ?? [];
  }
  return (await resolveJackOrganizations(caller.userId))
    .filter((org) => org.role === "organization_admin")
    .map(({ id, name }) => ({ id, name }));
}
