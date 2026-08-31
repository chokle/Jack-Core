import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Request } from "express";
import type { CallerIdentity } from "./admin-auth.js";
import { isPresentationIdentity, isUnavailableIdentity } from "./identity.js";
import { supabase } from "./supabase.js";

const db = supabase as unknown as { from: (table: string) => any };

export const TELEMETRY_SCHEMA_VERSION = 1 as const;
export const PRIVACY_NOTICE_VERSION = "jack-pilot-privacy-2026-07-25";
export const CONSENT_VERSION = "jack-pilot-consent-2026-07-25";
export const RAW_EVENT_RETENTION_DAYS = 90;
export const INGEST_FAILURE_RETENTION_DAYS = 30;
export const WITHDRAWAL_DELETION_DAYS = 30;

export const CLIENT_EVENT_TYPES = new Set([
  "test_completed",
  "test_abandoned",
  "onboarding_started",
  "onboarding_step_completed",
  "onboarding_completed",
  "onboarding_skipped",
  "feature_viewed",
  "workflow_completed",
  "recording_started",
  "recording_stopped",
  "recording_upload_succeeded",
  "recording_upload_failed",
  "feedback_submitted",
  "reliability_error",
]);

export const ALL_EVENT_TYPES = new Set([
  "test_started",
  "test_resumed",
  "test_completed",
  "test_abandoned",
  "test_expired",
  "onboarding_started",
  "onboarding_step_completed",
  "onboarding_completed",
  "onboarding_skipped",
  "feature_viewed",
  "workflow_completed",
  "ask_jack_completed",
  "ask_jack_failed",
  "recording_started",
  "recording_stopped",
  "recording_upload_succeeded",
  "recording_upload_failed",
  "feedback_submitted",
  "reliability_error",
]);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER_RE = /^[a-zA-Z0-9:_-]{1,128}$/;
const VERSION_RE = /^[a-zA-Z0-9._+-]{1,120}$/;
const DEVICE_CATEGORIES = new Set(["desktop", "tablet", "mobile"]);
const RESULTS = new Set(["success", "failure", "cancelled", "unavailable"]);
const PERMITTED_RESULTS_BY_EVENT: Record<string, ReadonlySet<string>> = {
  test_abandoned: new Set(["cancelled"]),
  test_expired: new Set(["unavailable"]),
  onboarding_skipped: new Set(["cancelled"]),
  recording_stopped: new Set(["success", "cancelled"]),
  ask_jack_failed: new Set(["failure"]),
  recording_upload_failed: new Set(["failure"]),
  reliability_error: new Set(["failure"]),
};
const FEATURES = new Set([
  "memory_graph",
  "library",
  "interview_mode",
  "knowledge_review",
  "video_detail",
]);
const WORKFLOWS = new Set([
  "interview_completed",
  "knowledge_review_completed",
  "video_reviewed",
]);
const ERROR_CODES = new Set([
  "api_unavailable",
  "network_error",
  "upload_failed",
  "recording_unavailable",
  "ask_jack_failed",
  "invalid_response",
  "queue_overflow",
]);
const STOP_REASONS = new Set(["user", "native_stop_sharing", "withdrawn", "error"]);
const SURFACE_BY_EVENT: Record<string, string> = {
  test_started: "pilot",
  test_resumed: "pilot",
  test_completed: "pilot",
  test_abandoned: "pilot",
  test_expired: "pilot",
  onboarding_started: "onboarding",
  onboarding_step_completed: "onboarding",
  onboarding_completed: "onboarding",
  onboarding_skipped: "onboarding",
  feature_viewed: "app",
  workflow_completed: "app",
  ask_jack_completed: "ask_jack",
  ask_jack_failed: "ask_jack",
  recording_started: "recording",
  recording_stopped: "recording",
  recording_upload_succeeded: "recording",
  recording_upload_failed: "recording",
  feedback_submitted: "feedback",
  reliability_error: "reliability",
};

export interface PilotScope {
  organizationId: string;
  pilotId: string;
  organizationName?: string;
  pilotName?: string;
  authority?: "tester" | "pilot_admin" | "organization_admin" | "platform_superadmin";
}

export interface ConsentSnapshot {
  id: string;
  state: "granted" | "declined" | "withdrawn";
  privacyNoticeVersion: string;
  consentVersion: string;
}

export function currentConsentGranted(consent: ConsentSnapshot | null): consent is ConsentSnapshot {
  return Boolean(
    consent?.state === "granted" &&
      consent.privacyNoticeVersion === PRIVACY_NOTICE_VERSION &&
      consent.consentVersion === CONSENT_VERSION,
  );
}

export interface CanonicalEventInput {
  eventId?: string;
  eventType: string;
  occurredAt?: string;
  appSessionId: string;
  metadata?: unknown;
  result?: string;
  correlationId?: string | null;
  requestId?: string | null;
  dedupeKey?: string | null;
  appVersion?: string | null;
  deployVersion?: string | null;
  deviceCategory?: string;
}

function isoAfter(days: number, from = Date.now()): string {
  return new Date(from + days * 24 * 60 * 60 * 1000).toISOString();
}

function isActiveWindow(row: Record<string, unknown>, now = Date.now()): boolean {
  if (row["active"] !== true) return false;
  const from = Date.parse(String(row["valid_from"] ?? ""));
  const until = row["valid_until"] ? Date.parse(String(row["valid_until"])) : Number.POSITIVE_INFINITY;
  return (!Number.isFinite(from) || from <= now) && (!Number.isFinite(until) || until > now);
}

export async function resolveActiveTesterScope(
  userId: string,
  requestedPilotId?: string | null,
): Promise<{ scope: PilotScope | null; reason?: "not_enrolled" | "ambiguous_pilot" }> {
  let query = db
    .from("pilot_memberships")
    .select("organization_id,pilot_id,user_id,role,active,valid_from,valid_until")
    .eq("user_id", userId)
    .eq("role", "tester")
    .eq("active", true);
  if (requestedPilotId) query = query.eq("pilot_id", requestedPilotId);
  const memberships = await query.limit(3);
  if (memberships.error) throw memberships.error;
  const active = (memberships.data ?? []).filter((row: Record<string, unknown>) =>
    isActiveWindow(row),
  );
  if (active.length === 0) return { scope: null, reason: "not_enrolled" };
  if (active.length > 1 && !requestedPilotId) {
    return { scope: null, reason: "ambiguous_pilot" };
  }
  const membership = active[0] as Record<string, unknown>;
  const pilotId = String(membership["pilot_id"] ?? "");
  const organizationId = String(membership["organization_id"] ?? "");
  if (!UUID_RE.test(pilotId) || !UUID_RE.test(organizationId)) {
    return { scope: null, reason: "not_enrolled" };
  }
  const pilot = await db
    .from("pilots")
    .select("id,organization_id,status,name")
    .eq("id", pilotId)
    .eq("organization_id", organizationId)
    .eq("status", "active")
    .maybeSingle();
  if (pilot.error) throw pilot.error;
  if (!pilot.data) return { scope: null, reason: "not_enrolled" };
  return {
    scope: {
      organizationId,
      pilotId,
      pilotName: String(pilot.data.name ?? ""),
      authority: "tester",
    },
  };
}

export async function activeTesterScopeMatches(
  userId: string,
  organizationId: string,
  pilotId: string,
): Promise<boolean> {
  const membership = await resolveActiveTesterScope(userId, pilotId);
  return Boolean(
    membership.scope &&
      membership.scope.organizationId === organizationId &&
      membership.scope.pilotId === pilotId,
  );
}

export async function latestConsent(
  userId: string,
  pilotId: string,
  scope: "telemetry" | "screen" | "microphone",
): Promise<ConsentSnapshot | null> {
  const result = await db
    .from("telemetry_consents")
    .select("id,state,privacy_notice_version,consent_version,occurred_at,consent_sequence")
    .eq("actor_user_id", userId)
    .eq("pilot_id", pilotId)
    .eq("scope", scope)
    .order("occurred_at", { ascending: false })
    .order("consent_sequence", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (result.error) throw result.error;
  if (!result.data) return null;
  return {
    id: String(result.data.id),
    state: result.data.state as ConsentSnapshot["state"],
    privacyNoticeVersion: String(result.data.privacy_notice_version),
    consentVersion: String(result.data.consent_version),
  };
}

export function browserFamily(userAgent: string | undefined): "Chrome" | "Safari" | "Edge" | "Firefox" | "Other" {
  const ua = userAgent ?? "";
  if (/\bEdg\//i.test(ua)) return "Edge";
  if (/\bFirefox\//i.test(ua)) return "Firefox";
  if (/\b(?:Chrome|CriOS)\//i.test(ua)) return "Chrome";
  if (/\bSafari\//i.test(ua) && /\bVersion\//i.test(ua)) return "Safari";
  return "Other";
}

export function deviceCategory(
  userAgent: string | undefined,
): "desktop" | "tablet" | "mobile" {
  const ua = userAgent ?? "";
  if (
    /\b(?:iPad|Tablet|PlayBook)\b/i.test(ua) ||
    (/\bAndroid\b/i.test(ua) && !/\bMobile\b/i.test(ua))
  ) {
    return "tablet";
  }
  if (/\b(?:Mobile|iPhone|iPod|Android)\b/i.test(ua)) return "mobile";
  return "desktop";
}

function exactKeys(input: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(input);
  return keys.length <= allowed.length && keys.every((key) => allowed.includes(key));
}

export function validateEventMetadata(
  eventType: string,
  raw: unknown,
): Record<string, string | number | boolean> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return raw === undefined ? {} : null;
  }
  const input = raw as Record<string, unknown>;
  const output: Record<string, string | number | boolean> = {};

  if (
    [
      "test_started",
      "test_resumed",
      "test_completed",
      "test_abandoned",
      "test_expired",
      "onboarding_started",
      "onboarding_completed",
      "recording_upload_succeeded",
      "feedback_submitted",
    ].includes(eventType)
  ) {
    return exactKeys(input, []) ? output : null;
  }
  if (eventType === "onboarding_step_completed") {
    if (!exactKeys(input, ["step", "next_step"])) return null;
    if (!Number.isInteger(input["step"]) || !Number.isInteger(input["next_step"])) return null;
    const step = Number(input["step"]);
    const next = Number(input["next_step"]);
    if (step < 1 || step > 3 || next < 0 || next > 3) return null;
    return { step, next_step: next };
  }
  if (eventType === "onboarding_skipped") {
    if (!exactKeys(input, ["step"]) || !Number.isInteger(input["step"])) return null;
    const step = Number(input["step"]);
    return step >= 1 && step <= 3 ? { step } : null;
  }
  if (eventType === "feature_viewed") {
    if (!exactKeys(input, ["feature"]) || !FEATURES.has(String(input["feature"]))) return null;
    return { feature: String(input["feature"]) };
  }
  if (eventType === "workflow_completed") {
    if (!exactKeys(input, ["workflow"]) || !WORKFLOWS.has(String(input["workflow"]))) return null;
    return { workflow: String(input["workflow"]) };
  }
  if (eventType === "ask_jack_completed") {
    if (!exactKeys(input, ["citation_count"]) || !Number.isInteger(input["citation_count"])) return null;
    const count = Number(input["citation_count"]);
    return count >= 0 && count <= 100 ? { citation_count: count } : null;
  }
  if (eventType === "recording_started") {
    if (!exactKeys(input, ["microphone_included"]) || typeof input["microphone_included"] !== "boolean") return null;
    return { microphone_included: input["microphone_included"] };
  }
  if (eventType === "recording_stopped") {
    if (!exactKeys(input, ["stop_reason"]) || !STOP_REASONS.has(String(input["stop_reason"]))) return null;
    return { stop_reason: String(input["stop_reason"]) };
  }
  if (["ask_jack_failed", "recording_upload_failed", "reliability_error"].includes(eventType)) {
    if (!exactKeys(input, ["error_code"]) || !ERROR_CODES.has(String(input["error_code"]))) return null;
    return { error_code: String(input["error_code"]) };
  }
  return null;
}

export function validateCanonicalEventInput(
  input: CanonicalEventInput,
  clientEvent: boolean,
): { value: Required<Pick<CanonicalEventInput, "eventId" | "eventType" | "occurredAt" | "appSessionId" | "metadata" | "result" | "deviceCategory">> & CanonicalEventInput } | { error: string } {
  if (!ALL_EVENT_TYPES.has(input.eventType) || (clientEvent && !CLIENT_EVENT_TYPES.has(input.eventType))) {
    return { error: "invalid_event_type" };
  }
  const eventId = input.eventId ?? randomUUID();
  if (!UUID_RE.test(eventId) || !UUID_RE.test(input.appSessionId)) {
    return { error: "invalid_identifier" };
  }
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const occurredMs = Date.parse(occurredAt);
  if (!Number.isFinite(occurredMs) || Math.abs(Date.now() - occurredMs) > 7 * 24 * 60 * 60 * 1000) {
    return { error: "invalid_occurred_at" };
  }
  const metadata = validateEventMetadata(input.eventType, input.metadata);
  if (!metadata) return { error: "invalid_metadata" };
  const result =
    input.result ??
    (input.eventType.endsWith("_failed") || input.eventType === "reliability_error"
      ? "failure"
      : input.eventType === "test_abandoned" || input.eventType === "onboarding_skipped"
        ? "cancelled"
        : input.eventType === "test_expired"
          ? "unavailable"
          : "success");
  if (!RESULTS.has(result)) return { error: "invalid_result" };
  const permittedResults = PERMITTED_RESULTS_BY_EVENT[input.eventType] ?? new Set(["success"]);
  if (!permittedResults.has(result)) return { error: "invalid_result" };
  const deviceCategory = input.deviceCategory ?? "desktop";
  if (!DEVICE_CATEGORIES.has(deviceCategory)) return { error: "invalid_device_category" };
  for (const value of [input.correlationId, input.requestId, input.dedupeKey]) {
    if (value != null && !IDENTIFIER_RE.test(value)) return { error: "invalid_identifier" };
  }
  for (const value of [input.appVersion, input.deployVersion]) {
    if (value != null && !VERSION_RE.test(value)) return { error: "invalid_version" };
  }
  return {
    value: {
      ...input,
      eventId,
      occurredAt: new Date(occurredMs).toISOString(),
      appSessionId: input.appSessionId,
      eventType: input.eventType,
      metadata,
      result,
      deviceCategory,
    },
  };
}

export async function recordIngestFailure(input: {
  actorUserId?: string | null;
  organizationId?: string | null;
  pilotId?: string | null;
  testSessionId?: string | null;
  reasonCode: string;
  outcome: "rejected" | "dropped";
  eventCount?: number;
}): Promise<void> {
  const reasonCode = /^[a-z0-9_]{1,64}$/.test(input.reasonCode)
    ? input.reasonCode
    : "unknown_rejection";
  const result = await db.from("activity_ingest_failures").insert({
    id: randomUUID(),
    actor_user_id: input.actorUserId ?? null,
    organization_id: input.organizationId ?? null,
    pilot_id: input.pilotId ?? null,
    test_session_id: input.testSessionId ?? null,
    reason_code: reasonCode,
    outcome: input.outcome,
    event_count: Math.max(1, Math.min(input.eventCount ?? 1, 1000)),
    retained_until: isoAfter(INGEST_FAILURE_RETENTION_DAYS),
  });
  if (result.error) throw result.error;
}

export async function insertCanonicalEvent(input: {
  req?: Request;
  actorUserId: string;
  session: Record<string, any>;
  consent: ConsentSnapshot;
  event: CanonicalEventInput;
  clientEvent: boolean;
}): Promise<{ duplicate: boolean; row?: Record<string, unknown>; error?: string }> {
  const validated = validateCanonicalEventInput(input.event, input.clientEvent);
  if ("error" in validated) return { duplicate: false, error: validated.error };
  const event = validated.value;

  const duplicateMatches = (row: Record<string, unknown>): boolean =>
    row["actor_user_id"] === input.actorUserId &&
    row["test_session_id"] === input.session.id &&
    row["app_session_id"] === event.appSessionId &&
    row["event_type"] === event.eventType &&
    row["result"] === event.result &&
    (row["dedupe_key"] ?? null) === (event.dedupeKey ?? null) &&
    isDeepStrictEqual(row["metadata"] ?? {}, event.metadata);

  const existing = await db
    .from("test_events")
    .select("*")
    .eq("event_id", event.eventId)
    .maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data) {
    return duplicateMatches(existing.data)
      ? { duplicate: true, row: existing.data }
      : { duplicate: false, error: "idempotency_conflict" };
  }
  if (event.dedupeKey) {
    const dedupe = await db
      .from("test_events")
      .select("*")
      .eq("test_session_id", input.session.id)
      .eq("dedupe_key", event.dedupeKey)
      .maybeSingle();
    if (dedupe.error) throw dedupe.error;
    if (dedupe.data) {
      return duplicateMatches(dedupe.data)
        ? { duplicate: true, row: dedupe.data }
        : { duplicate: false, error: "idempotency_conflict" };
    }
  }

  const row = {
    event_id: event.eventId,
    actor_user_id: input.actorUserId,
    organization_id: input.session.organization_id,
    pilot_id: input.session.pilot_id,
    test_session_id: input.session.id,
    app_session_id: event.appSessionId,
    event_type: event.eventType,
    occurred_at: event.occurredAt,
    received_at: new Date().toISOString(),
    surface: SURFACE_BY_EVENT[event.eventType],
    route: "/app",
    schema_version: TELEMETRY_SCHEMA_VERSION,
    metadata: event.metadata,
    consent_state: "granted",
    consent_id: input.consent.id,
    privacy_notice_version: input.consent.privacyNoticeVersion,
    consent_version: input.consent.consentVersion,
    app_version: event.appVersion ?? null,
    deploy_version: event.deployVersion ?? null,
    device_category: event.deviceCategory,
    browser_family: browserFamily(input.req?.headers["user-agent"]),
    result: event.result,
    correlation_id: event.correlationId ?? null,
    request_id: event.requestId ?? null,
    dedupe_key: event.dedupeKey ?? null,
    retention_category: "raw_activity_90d",
    retained_until: isoAfter(RAW_EVENT_RETENTION_DAYS),
  };
  const inserted = await db.from("test_events").insert(row);
  if (inserted.error) {
    if ((inserted.error as { code?: string }).code === "23505") {
      let duplicate = await db
        .from("test_events")
        .select("*")
        .eq("event_id", event.eventId)
        .maybeSingle();
      if (duplicate.error) throw duplicate.error;
      if (!duplicate.data && event.dedupeKey) {
        duplicate = await db
          .from("test_events")
          .select("*")
          .eq("test_session_id", input.session.id)
          .eq("dedupe_key", event.dedupeKey)
          .maybeSingle();
        if (duplicate.error) throw duplicate.error;
      }
      return duplicate.data && duplicateMatches(duplicate.data)
        ? { duplicate: true, row: duplicate.data }
        : { duplicate: false, error: "idempotency_conflict" };
    }
    throw inserted.error;
  }
  return { duplicate: false, row };
}

async function platformSuperadmin(userId: string): Promise<boolean> {
  const role = await db
    .from("platform_roles")
    .select("id")
    .eq("user_id", userId)
    .eq("role", "platform_superadmin")
    .eq("active", true)
    .maybeSingle();
  if (role.error) throw role.error;
  return Boolean(role.data);
}

async function pilotBelongsToOrganization(pilotId: string, organizationId: string): Promise<boolean> {
  const pilot = await db
    .from("pilots")
    .select("id")
    .eq("id", pilotId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (pilot.error) throw pilot.error;
  return Boolean(pilot.data);
}

export async function authorizeReportScope(
  userId: string,
  organizationId: string,
  pilotId: string,
): Promise<{ allowed: boolean; authority?: PilotScope["authority"] }> {
  if (!UUID_RE.test(organizationId) || !UUID_RE.test(pilotId)) return { allowed: false };
  if (!(await pilotBelongsToOrganization(pilotId, organizationId))) return { allowed: false };
  if (await platformSuperadmin(userId)) {
    return { allowed: true, authority: "platform_superadmin" };
  }
  const pilotAdmin = await db
    .from("pilot_memberships")
    .select("active,valid_from,valid_until")
    .eq("user_id", userId)
    .eq("organization_id", organizationId)
    .eq("pilot_id", pilotId)
    .eq("role", "pilot_admin")
    .eq("active", true)
    .maybeSingle();
  if (pilotAdmin.error) throw pilotAdmin.error;
  if (pilotAdmin.data && isActiveWindow(pilotAdmin.data)) {
    return { allowed: true, authority: "pilot_admin" };
  }
  const organizationAdmin = await db
    .from("pilot_memberships")
    .select("active,valid_from,valid_until")
    .eq("user_id", userId)
    .eq("organization_id", organizationId)
    .eq("role", "organization_admin")
    .eq("active", true)
    .maybeSingle();
  if (organizationAdmin.error) throw organizationAdmin.error;
  if (organizationAdmin.data && isActiveWindow(organizationAdmin.data)) {
    return { allowed: true, authority: "organization_admin" };
  }
  return { allowed: false };
}

export async function hasAnyReportScope(userId: string): Promise<boolean> {
  if (await platformSuperadmin(userId)) return true;
  const memberships = await db
    .from("pilot_memberships")
    .select("active,valid_from,valid_until,role")
    .eq("user_id", userId)
    .eq("active", true);
  if (memberships.error) throw memberships.error;
  return (memberships.data ?? []).some(
    (membership: Record<string, unknown>) =>
      (membership["role"] === "pilot_admin" || membership["role"] === "organization_admin") &&
      isActiveWindow(membership),
  );
}

export async function listReportScopes(userId: string): Promise<PilotScope[]> {
  const isPlatform = await platformSuperadmin(userId);
  const pilotsResult = await db
    .from("pilots")
    .select("id,organization_id,name,status")
    .eq("status", "active")
    .order("name", { ascending: true });
  if (pilotsResult.error) throw pilotsResult.error;
  const organizationsResult = await db
    .from("organizations")
    .select("id,name,status")
    .eq("status", "active");
  if (organizationsResult.error) throw organizationsResult.error;
  const organizationNames = new Map<string, string>(
    (organizationsResult.data ?? []).map((row: Record<string, unknown>) => [
      String(row["id"]),
      String(row["name"]),
    ]),
  );

  if (isPlatform) {
    return (pilotsResult.data ?? []).map((pilot: Record<string, unknown>) => ({
      organizationId: String(pilot["organization_id"]),
      pilotId: String(pilot["id"]),
      organizationName: organizationNames.get(String(pilot["organization_id"])) ?? "Organization",
      pilotName: String(pilot["name"]),
      authority: "platform_superadmin",
    }));
  }

  const memberships = await db
    .from("pilot_memberships")
    .select("organization_id,pilot_id,role,active,valid_from,valid_until")
    .eq("user_id", userId)
    .eq("active", true);
  if (memberships.error) throw memberships.error;
  const active = (memberships.data ?? []).filter((row: Record<string, unknown>) =>
    isActiveWindow(row),
  );
  const scopes = new Map<string, PilotScope>();
  for (const pilot of pilotsResult.data ?? []) {
    const organizationId = String(pilot.organization_id);
    const pilotId = String(pilot.id);
    const direct = active.find(
      (row: Record<string, unknown>) =>
        row["role"] === "pilot_admin" &&
        row["organization_id"] === organizationId &&
        row["pilot_id"] === pilotId,
    );
    const organization = active.find(
      (row: Record<string, unknown>) =>
        row["role"] === "organization_admin" && row["organization_id"] === organizationId,
    );
    const membership = direct ?? organization;
    if (!membership) continue;
    scopes.set(`${organizationId}:${pilotId}`, {
      organizationId,
      pilotId,
      organizationName: organizationNames.get(organizationId) ?? "Organization",
      pilotName: String(pilot.name),
      authority: direct ? "pilot_admin" : "organization_admin",
    });
  }
  return [...scopes.values()];
}

export async function auditReportAccess(input: {
  userId: string;
  targetUserId?: string | null;
  organizationId?: string | null;
  pilotId?: string | null;
  action: string;
  decision: "allowed" | "denied";
  authority?: PilotScope["authority"];
  requestId?: string | null;
}): Promise<void> {
  const result = await db.from("admin_access_audit").insert({
    id: randomUUID(),
    actor_user_id: input.userId,
    target_user_id: input.targetUserId ?? null,
    organization_id: input.organizationId ?? null,
    pilot_id: input.pilotId ?? null,
    action: input.action,
    decision: input.decision,
    authority: input.authority === "tester" ? null : input.authority ?? null,
    request_id: input.requestId ?? null,
    retained_until: isoAfter(730),
  });
  if (result.error) throw result.error;
}

export function requestIdentifier(req: Request): string {
  const candidate = req.headers["x-request-id"];
  if (typeof candidate === "string" && IDENTIFIER_RE.test(candidate)) return candidate;
  const pinoId = (req as Request & { id?: unknown }).id;
  return typeof pinoId === "string" && IDENTIFIER_RE.test(pinoId) ? pinoId : randomUUID();
}

export async function compensateTelemetryWriteAfterWithdrawal(
  userId: string,
  pilotId: string,
  sessionId: string,
): Promise<void> {
  const now = new Date().toISOString();
  const deletionDueAt = isoAfter(WITHDRAWAL_DELETION_DAYS);
  const results = await Promise.all([
    db
      .from("test_sessions")
      .update({
        status: "withdrawn",
        telemetry_status: "withdrawn",
        screen_consent_state: "withdrawn",
        microphone_consent_state: "withdrawn",
        recording_status: "withdrawn",
        deletion_due_at: deletionDueAt,
        updated_at: now,
      })
      .eq("id", sessionId)
      .eq("actor_user_id", userId)
      .eq("pilot_id", pilotId),
    db
      .from("test_events")
      .update({
        metadata: {},
        correlation_id: null,
        request_id: null,
        redacted_at: now,
        deletion_due_at: deletionDueAt,
      })
      .eq("test_session_id", sessionId)
      .eq("actor_user_id", userId)
      .eq("pilot_id", pilotId),
    db
      .from("activity_ingest_failures")
      .delete()
      .eq("test_session_id", sessionId)
      .eq("actor_user_id", userId)
      .eq("pilot_id", pilotId),
    db
      .from("test_recordings")
      .update({ deletion_due_at: deletionDueAt })
      .eq("test_session_id", sessionId)
      .eq("tester_user_id", userId)
      .eq("pilot_id", pilotId),
    db
      .from("test_feedback")
      .update({
        deletion_due_at: deletionDueAt,
        notification_status: "failed",
        notification_last_error: "telemetry_consent_withdrawn",
        notification_next_attempt_at: null,
        updated_at: now,
      })
      .eq("test_session_id", sessionId)
      .eq("tester_user_id", userId)
      .eq("pilot_id", pilotId),
  ]);
  const failed = results.find((result) => result.error);
  if (failed?.error) throw failed.error;
}

async function exactTelemetryConsentStillCurrent(
  userId: string,
  pilotId: string,
  consentId: string,
): Promise<boolean> {
  const current = await latestConsent(userId, pilotId, "telemetry");
  return currentConsentGranted(current) && current.id === consentId;
}

async function redactRejectedTelemetryEvent(input: {
  eventId: string;
  userId: string;
  pilotId: string;
  sessionId: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const redacted = await db
    .from("test_events")
    .update({
      metadata: {},
      correlation_id: null,
      request_id: null,
      redacted_at: now,
      deletion_due_at: isoAfter(WITHDRAWAL_DELETION_DAYS),
    })
    .eq("event_id", input.eventId)
    .eq("actor_user_id", input.userId)
    .eq("pilot_id", input.pilotId)
    .eq("test_session_id", input.sessionId);
  if (redacted.error) throw redacted.error;
}

export async function recordServerAskJackEvent(input: {
  req: Request;
  actorIdentity: CallerIdentity | null;
  eventType: "ask_jack_completed" | "ask_jack_failed";
  correlationId: string;
  citationCount?: number;
}): Promise<void> {
  try {
    if (
      !input.actorIdentity ||
      input.actorIdentity.isAdmin ||
      isUnavailableIdentity(input.actorIdentity) ||
      isPresentationIdentity(input.actorIdentity)
    ) {
      return;
    }
    const actorUserId = input.actorIdentity.userId;
    const requestedSessionId = input.req.headers["x-jack-test-session-id"];
    let sessionQuery = db
      .from("test_sessions")
      .select("*")
      .eq("actor_user_id", actorUserId)
      .eq("status", "active")
      .eq("telemetry_status", "granted");
    if (typeof requestedSessionId === "string" && UUID_RE.test(requestedSessionId)) {
      sessionQuery = sessionQuery.eq("id", requestedSessionId);
    }
    const sessions = await sessionQuery
      .order("last_activity_at", { ascending: false })
      .limit(2);
    if (sessions.error || sessions.data?.length !== 1) return;
    const session = sessions.data[0] as Record<string, any>;
    const pilotId = String(session.pilot_id);
    if (
      !(await activeTesterScopeMatches(
        actorUserId,
        String(session.organization_id),
        pilotId,
      ))
    ) {
      return;
    }
    const consent = await latestConsent(actorUserId, pilotId, "telemetry");
    if (
      !currentConsentGranted(consent) ||
      consent.id !== String(session.telemetry_consent_id)
    ) return;
    const result = await insertCanonicalEvent({
      req: input.req,
      actorUserId,
      session,
      consent,
      clientEvent: false,
      event: {
        eventId: randomUUID(),
        eventType: input.eventType,
        occurredAt: new Date().toISOString(),
        appSessionId: String(session.app_session_id),
        metadata:
          input.eventType === "ask_jack_completed"
            ? { citation_count: Math.max(0, Math.min(input.citationCount ?? 0, 100)) }
            : { error_code: "ask_jack_failed" },
        result: input.eventType === "ask_jack_completed" ? "success" : "failure",
        correlationId: input.correlationId,
        requestId: requestIdentifier(input.req),
        deviceCategory:
          typeof session.device_category === "string"
            ? session.device_category
            : deviceCategory(input.req.headers["user-agent"]),
      },
    });
    if (result.error) return;
    if (!(await exactTelemetryConsentStillCurrent(actorUserId, pilotId, consent.id))) {
      await compensateTelemetryWriteAfterWithdrawal(
        actorUserId,
        pilotId,
        String(session.id),
      );
      return;
    }
    if (!result.duplicate) {
      const now = new Date().toISOString();
      const projected = await db
        .from("test_sessions")
        .update({
          question_count: Number(session.question_count ?? 0) + 1,
          last_activity_at: now,
          updated_at: now,
        })
        .eq("id", session.id)
        .eq("actor_user_id", actorUserId)
        .eq("status", "active")
        .eq("telemetry_status", "granted")
        .eq("telemetry_consent_id", consent.id)
        .select("id")
        .maybeSingle();
      if (projected.error) throw projected.error;
      if (!projected.data) {
        if (!(await exactTelemetryConsentStillCurrent(actorUserId, pilotId, consent.id))) {
          await compensateTelemetryWriteAfterWithdrawal(
            actorUserId,
            pilotId,
            String(session.id),
          );
        } else if (!result.duplicate && result.row?.["event_id"]) {
          await redactRejectedTelemetryEvent({
            eventId: String(result.row["event_id"]),
            userId: actorUserId,
            pilotId,
            sessionId: String(session.id),
          });
        }
        return;
      }
      if (!(await exactTelemetryConsentStillCurrent(actorUserId, pilotId, consent.id))) {
        await compensateTelemetryWriteAfterWithdrawal(
          actorUserId,
          pilotId,
          String(session.id),
        );
      }
    }
  } catch (error) {
    input.req.log?.warn({ err: error }, "server activity telemetry write failed");
  }
}

export const activityDb = db;
