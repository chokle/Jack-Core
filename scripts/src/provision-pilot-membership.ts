import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env["SUPABASE_URL"];
const supabaseServiceRoleKey = process.env["SUPABASE_SERVICE_ROLE_KEY"];

if (!supabaseUrl) throw new Error("SUPABASE_URL is required");
if (!supabaseServiceRoleKey)
  throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Role = "tester" | "pilot_admin" | "organization_admin";

interface Args {
  organizationId: string;
  role: Role;
  userId: string;
  pilotId?: string;
  active: boolean;
  validFrom: string;
  validUntil?: string;
  createdByUserId?: string;
  confirm: boolean;
}

interface RawConfig {
  organizationId?: string;
  userId?: string;
  pilotId?: string;
  role?: string;
  active?: string;
  validFrom?: string;
  validUntil?: string;
  createdByUserId?: string;
}

function parseArgs(argv: string[]): RawConfig & { flags: Set<string> } {
  const options: RawConfig = {};
  const flags = new Set<string>();

  const normalizeKey = (key: string): keyof RawConfig | null => {
    if (key === "organization-id" || key === "organizationId")
      return "organizationId";
    if (key === "user-id" || key === "userId") return "userId";
    if (key === "pilot-id" || key === "pilotId") return "pilotId";
    if (key === "role") return "role";
    if (key === "active") return "active";
    if (key === "valid-from" || key === "validFrom") return "validFrom";
    if (key === "valid-until" || key === "validUntil") return "validUntil";
    if (key === "created-by-user-id" || key === "createdByUserId")
      return "createdByUserId";
    return null;
  };

  for (const arg of argv) {
    if (arg === "--confirm") {
      flags.add("confirm");
      continue;
    }
    if (!arg.startsWith("--")) continue;
    const [key, value] = arg.slice(2).split("=", 2);
    if (!value) continue;
    const normalized = normalizeKey(key);
    if (normalized && value.length > 0) {
      options[normalized] = value;
    }
  }

  return {
    ...(Object.fromEntries(
      Object.entries({
        organizationId: process.env["PILOT_MEMBERSHIP_ORGANIZATION_ID"]?.trim(),
        userId: process.env["PILOT_MEMBERSHIP_USER_ID"]?.trim(),
        pilotId: process.env["PILOT_MEMBERSHIP_PILOT_ID"]?.trim(),
        role: process.env["PILOT_MEMBERSHIP_ROLE"]?.trim(),
        active: process.env["PILOT_MEMBERSHIP_ACTIVE"]?.trim(),
        validFrom: process.env["PILOT_MEMBERSHIP_VALID_FROM"]?.trim(),
        validUntil: process.env["PILOT_MEMBERSHIP_VALID_UNTIL"]?.trim(),
        createdByUserId:
          process.env["PILOT_MEMBERSHIP_CREATED_BY_USER_ID"]?.trim(),
      }).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && entry[1] !== "",
      ),
    ) as Partial<RawConfig>),
    ...Object.fromEntries(Object.entries(options)),
    flags,
  };
}

function parseArgsToConfig(argv: string[]): Args {
  const raw = parseArgs(argv);
  const roleInput = (raw.role ?? "tester").toLowerCase();
  if (!["tester", "pilot_admin", "organization_admin"].includes(roleInput)) {
    throw new Error(`Invalid role: ${raw.role}`);
  }

  const organizationId = (raw.organizationId ?? "").trim();
  const userId = (raw.userId ?? "").trim();
  const pilotIdRaw = raw.pilotId?.trim();
  const role = roleInput as Role;

  if (!organizationId || !UUID_RE.test(organizationId)) {
    throw new Error(
      "PILOT_MEMBERSHIP_ORGANIZATION_ID is required and must be a UUID (or pass --organization-id=...).",
    );
  }
  if (!userId || !userId.startsWith("user_")) {
    throw new Error(
      "PILOT_MEMBERSHIP_USER_ID is required and should look like a Clerk user id.",
    );
  }

  if (role === "organization_admin" && pilotIdRaw) {
    throw new Error("organization_admin cannot be assigned to a pilot_id.");
  }
  if (role !== "organization_admin" && !pilotIdRaw) {
    throw new Error(
      "pilot_id is required for tester and pilot_admin roles (PILOT_MEMBERSHIP_PILOT_ID / --pilot-id).",
    );
  }
  if (
    (pilotIdRaw && !UUID_RE.test(pilotIdRaw)) ||
    (pilotIdRaw && role !== "organization_admin" && !pilotIdRaw)
  ) {
    throw new Error(
      "PILOT_MEMBERSHIP_PILOT_ID is required and must be a UUID.",
    );
  }

  const parseBool = (
    value: string | undefined,
    defaultValue: boolean,
  ): boolean => {
    if (!value) return defaultValue;
    const normalized = (value ?? "").toLowerCase().trim();
    return normalized === "true" || normalized === "1" || normalized === "yes";
  };

  const validateIso = (value?: string): string | undefined => {
    if (!value) return undefined;
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) throw new Error(`Invalid date: ${value}`);
    return new Date(parsed).toISOString();
  };

  const rawUntil = raw.validUntil;
  const validUntil = validateIso(rawUntil);
  const rawFrom = raw.validFrom;
  const validFrom = validateIso(rawFrom) ?? new Date().toISOString();

  if (
    validUntil &&
    new Date(validUntil).getTime() <= new Date(validFrom).getTime()
  ) {
    throw new Error("valid_until must be later than valid_from.");
  }

  return {
    organizationId,
    role,
    userId,
    pilotId: pilotIdRaw,
    active: parseBool(raw.active, true),
    validFrom,
    ...(validUntil ? { validUntil } : {}),
    ...(raw.createdByUserId ? { createdByUserId: raw.createdByUserId } : {}),
    ...(raw.flags?.has("confirm") ? { confirm: true } : { confirm: false }),
  };
}

function usage(): void {
  console.log(`Usage:
pnpm --filter @workspace/scripts run provision:pilot-membership -- \
  --organization-id=<uuid> --user-id=user_... --pilot-id=<uuid> --role=tester [--confirm]

Required runtime env:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY

Optional env:
  PILOT_MEMBERSHIP_ORGANIZATION_ID
  PILOT_MEMBERSHIP_PILOT_ID
  PILOT_MEMBERSHIP_USER_ID
  PILOT_MEMBERSHIP_ROLE (tester | pilot_admin | organization_admin)
  PILOT_MEMBERSHIP_ACTIVE (true | false)
  PILOT_MEMBERSHIP_VALID_FROM (ISO-8601)
  PILOT_MEMBERSHIP_VALID_UNTIL (ISO-8601)
  PILOT_MEMBERSHIP_CREATED_BY_USER_ID

Use --confirm to write. Without --confirm, prints the planned action only.

Note: role=organization_admin never accepts pilot-id by design.
`);
}

async function ensureOrganization(
  supabase: any,
  organizationId: string,
): Promise<void> {
  const { data, error } = await supabase
    .from("organizations")
    .select("id,name,status")
    .eq("id", organizationId)
    .maybeSingle();

  if (error)
    throw new Error(
      `Failed to resolve organization ${organizationId}: ${error.message}`,
    );
  const org = data as { status?: string } | null;
  if (!org) throw new Error(`Organization ${organizationId} does not exist.`);
  if (org.status !== "active") {
    throw new Error(
      `Organization ${organizationId} is not active (${org.status}).`,
    );
  }
}

async function ensurePilotBelongsToOrg(
  supabase: any,
  organizationId: string,
  pilotId: string,
): Promise<void> {
  const { data, error } = await supabase
    .from("pilots")
    .select("id,organization_id,status")
    .eq("id", pilotId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error)
    throw new Error(`Failed to resolve pilot ${pilotId}: ${error.message}`);
  const pilot = data as { status?: string } | null;
  if (!pilot) {
    throw new Error(
      `Pilot ${pilotId} does not exist in organization ${organizationId}.`,
    );
  }
  if (pilot.status !== "active") {
    throw new Error(`Pilot ${pilotId} is not active (${pilot.status}).`);
  }
}

function buildMembershipPayload(config: Args) {
  return {
    organization_id: config.organizationId,
    ...(config.pilotId ? { pilot_id: config.pilotId } : {}),
    user_id: config.userId,
    role: config.role,
    active: config.active,
    valid_from: config.validFrom,
    ...(config.validUntil ? { valid_until: config.validUntil } : {}),
    ...(config.createdByUserId
      ? { created_by_user_id: config.createdByUserId }
      : {}),
  };
}

async function resolveExisting(
  supabase: any,
  config: Args,
): Promise<Record<string, unknown> | null> {
  let query = supabase
    .from("pilot_memberships")
    .select(
      "id,organization_id,pilot_id,user_id,role,active,valid_from,valid_until,created_by_user_id,created_at",
    )
    .eq("organization_id", config.organizationId)
    .eq("user_id", config.userId)
    .eq("role", config.role);

  if (config.role === "organization_admin") {
    query = query.is("pilot_id", null);
  } else {
    query = query.eq("pilot_id", config.pilotId!);
  }

  const result = await query.maybeSingle();
  if (result.error)
    throw new Error(
      `Failed to query existing membership: ${result.error.message}`,
    );
  return result.data as Record<string, unknown> | null;
}

function membershipPlan(
  existing: Record<string, unknown> | null,
  payload: ReturnType<typeof buildMembershipPayload>,
) {
  if (!existing) return "create";
  const candidate = { ...existing };
  const unchanged =
    candidate.active === payload.active &&
    candidate.valid_from === payload.valid_from &&
    candidate.valid_until ===
      (payload as { valid_until?: string }).valid_until &&
    (candidate.created_by_user_id ?? null) ===
      (payload as { created_by_user_id?: string }).created_by_user_id;

  return unchanged ? "noop" : "update";
}

async function upsertMembership(supabase: any, config: Args): Promise<void> {
  await ensureOrganization(supabase, config.organizationId);
  const pilotId = config.pilotId;
  if (pilotId)
    await ensurePilotBelongsToOrg(supabase, config.organizationId, pilotId);

  const payload = buildMembershipPayload(config);
  const existing = await resolveExisting(supabase, config);
  const plan = membershipPlan(existing, payload);

  if (!config.confirm) {
    console.log(
      `Dry run: ${plan === "create" ? "would create" : plan === "update" ? "would update" : "already up to date"}`,
    );
    console.log("Membership payload:", JSON.stringify(payload, null, 2));
    return;
  }

  if (!config.confirm) return;

  if (plan === "noop" && existing) {
    console.log(
      `No-op: existing membership is already aligned: ${existing.id}`,
    );
    return;
  }

  if (existing) {
    const membershipId = String(existing.id);
    const { error: updateError } = await supabase
      .from("pilot_memberships")
      .update({
        active: payload.active,
        valid_from: payload.valid_from,
        valid_until: payload.valid_until ?? null,
        created_by_user_id: payload.created_by_user_id ?? null,
      })
      .eq("id", membershipId);
    if (updateError) {
      throw new Error(
        `Failed to update membership ${membershipId}: ${updateError.message}`,
      );
    }
    console.log(`Updated membership ${membershipId}`);
    return;
  }

  const { error: insertError } = await supabase
    .from("pilot_memberships")
    .insert({
      organization_id: payload.organization_id,
      pilot_id: payload.pilot_id ?? null,
      user_id: payload.user_id,
      role: payload.role,
      active: payload.active,
      valid_from: payload.valid_from,
      valid_until: payload.valid_until ?? null,
      created_by_user_id: payload.created_by_user_id ?? null,
    });

  if (insertError) {
    throw new Error(`Failed to insert membership: ${insertError.message}`);
  }

  console.log(
    `Created pilot_memberships row for ${config.role} user ${config.userId} in organization ${config.organizationId}${
      config.pilotId ? `, pilot ${config.pilotId}` : ""
    }.`,
  );
}

async function run(): Promise<void> {
  const args = parseArgsToConfig(process.argv.slice(2));
  const supabase = createClient(
    supabaseUrl as string,
    supabaseServiceRoleKey as string,
    {
      auth: { persistSession: false },
    },
  );

  if (!args.confirm) {
    usage();
  }

  await upsertMembership(supabase, args);
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
