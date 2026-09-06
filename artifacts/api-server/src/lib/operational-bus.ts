import { randomUUID } from "node:crypto";
import type { Request } from "express";
import {
  createOperationalState,
  OperationalEventSchema,
  reduceOperationalEvent,
  type OperationalEvent,
  type OperationalScope,
  type OperationalFilters,
} from "@workspace/api-zod";
import type { CallerIdentity } from "./admin-auth.js";
import { resolveIdentity } from "./admin-auth.js";
import {
  activityDb as db,
  resolveActiveTesterScope,
  latestConsent,
  currentConsentGranted,
  authorizeReportScope,
  auditReportAccess,
  requestIdentifier,
  type ConsentSnapshot,
} from "./activity-telemetry.js";
import {
  operationalState,
  personalOperationalScope,
  operationalProvenance,
  type EventInput,
} from "./operational-state.js";

export interface OperationalContext {
  scope: OperationalScope;
  sessionId: string | null;
  pilotId: string | null;
  consent: ConsentSnapshot | null;
}
export class OperationalAccessError extends Error {}

/** Existing pilot membership/report scopes authorize selection, never filters alone.
 * Site/crew grants have no real adapter yet and fail closed instead of being inferred. */
export async function resolveOperationalContext(
  req: Request,
  identity: CallerIdentity,
  filters: OperationalFilters = {},
): Promise<OperationalContext> {
  if (filters.siteId || filters.crewId)
    throw new OperationalAccessError(
      "No authorized site or crew adapter is configured.",
    );
  const target = filters.userId ?? identity.userId;
  let reportScope: { organizationId: string; pilotId: string } | null = null;
  if (target !== identity.userId || filters.organizationId || filters.pilotId) {
    const grant =
      identity.isAdmin && filters.organizationId && filters.pilotId
        ? await authorizeReportScope(
            identity.userId,
            filters.organizationId,
            filters.pilotId,
          )
        : { allowed: false };
    await auditReportAccess({
      userId: identity.userId,
      targetUserId: target,
      organizationId: filters.organizationId,
      pilotId: filters.pilotId,
      action: "operational_history",
      decision: grant.allowed ? "allowed" : "denied",
      requestId: requestIdentifier(req),
    });
    if (!grant.allowed)
      throw new OperationalAccessError("No authorized operational scope.");
    reportScope = {
      organizationId: filters.organizationId!,
      pilotId: filters.pilotId!,
    };
  }
  // Existing report grants include authorized historical sessions. Read access
  // must not invent a requirement that the former participant is still active;
  // publication remains fenced by active membership in the database trigger.
  const membership = reportScope
    ? { scope: reportScope }
    : await resolveActiveTesterScope(target, filters.pilotId);
  const fallback: OperationalContext = {
    scope: personalOperationalScope(identity.userId),
    sessionId: null,
    pilotId: null,
    consent: null,
  };
  if (!membership.scope) {
    if (
      target !== identity.userId ||
      filters.sessionId ||
      filters.organizationId ||
      filters.pilotId
    )
      throw new OperationalAccessError("No active scoped membership.");
    return fallback;
  }
  const { organizationId, pilotId } = membership.scope;
  if (filters.organizationId && filters.organizationId !== organizationId)
    throw new OperationalAccessError("Organization scope mismatch.");
  const consent = await latestConsent(target, pilotId, "telemetry");
  if (!currentConsentGranted(consent)) {
    if (
      target !== identity.userId ||
      filters.sessionId ||
      filters.organizationId ||
      filters.pilotId
    )
      throw new OperationalAccessError(
        "Current telemetry consent required for history.",
      );
    return fallback;
  }
  let query = db
    .from("test_sessions")
    .select("id,organization_id,pilot_id,actor_user_id,telemetry_consent_id")
    .eq("actor_user_id", target)
    .eq("organization_id", organizationId)
    .eq("pilot_id", pilotId)
    .eq("telemetry_status", "granted")
    .eq("telemetry_consent_id", consent.id);
  const sessionId =
    filters.sessionId ??
    (typeof req.headers["x-jack-test-session-id"] === "string"
      ? req.headers["x-jack-test-session-id"]
      : null);
  query = sessionId ? query.eq("id", sessionId) : query.eq("status", "active");
  const sessions = await query.limit(2);
  if (sessions.error) throw sessions.error;
  if (sessions.data?.length !== 1) {
    if (sessionId || target !== identity.userId)
      throw new OperationalAccessError("No unique authorized session.");
    return fallback;
  }
  return {
    scope: { userId: target, organizationId, siteId: null },
    sessionId: String(sessions.data[0].id),
    pilotId,
    consent,
  };
}

export interface OperationalJournal {
  append(context: OperationalContext, event: OperationalEvent): Promise<void>;
  load(context: OperationalContext): Promise<OperationalEvent[]>;
}

export class SupabaseOperationalJournal implements OperationalJournal {
  private async consentCurrent(context: OperationalContext) {
    if (!context.pilotId || !context.consent || !context.sessionId)
      throw new OperationalAccessError("Durable session required.");
    const current = await latestConsent(
      context.scope.userId,
      context.pilotId,
      "telemetry",
    );
    if (!currentConsentGranted(current) || current.id !== context.consent.id)
      throw new OperationalAccessError("Consent changed.");
  }
  async append(context: OperationalContext, event: OperationalEvent) {
    await this.consentCurrent(context);
    const row = {
      event_id: event.id,
      actor_user_id: context.scope.userId,
      organization_id: context.scope.organizationId,
      pilot_id: context.pilotId,
      test_session_id: context.sessionId,
      consent_id: context.consent!.id,
      event: { ...event, sequence: 1 },
      site_id: context.scope.siteId,
      crew_id: event.crewId,
    };
    const result = await db.from("jack_operational_events").insert(row);
    if (result.error) throw result.error;
    // DB trigger fences races; current consent is checked again before publication.
    await this.consentCurrent(context);
  }
  async load(context: OperationalContext) {
    await this.consentCurrent(context);
    const events: OperationalEvent[] = [];
    for (let offset = 0; offset < 10000; offset += 500) {
      let query = db
        .from("jack_operational_events")
        .select("sequence,event")
        .eq("actor_user_id", context.scope.userId)
        .eq("organization_id", context.scope.organizationId)
        .eq("pilot_id", context.pilotId)
        .eq("test_session_id", context.sessionId)
        .eq("consent_id", context.consent!.id)
        .is("site_id", null)
        .is("crew_id", null)
        .gt("retained_until", new Date().toISOString())
        .order("sequence", { ascending: true })
        .range(offset, offset + 499);
      const result = await query;
      if (result.error) throw result.error;
      for (const row of result.data ?? []) {
        const event = OperationalEventSchema.parse({
          ...row.event,
          sequence: Number(row.sequence),
        });
        if (
          event.scope.userId !== context.scope.userId ||
          event.scope.organizationId !== context.scope.organizationId ||
          event.scope.siteId !== context.scope.siteId ||
          event.sessionId !== context.sessionId ||
          event.crewId !== null
        )
          throw new Error("Invalid event scope in journal.");
        events.push(event);
      }
      if ((result.data?.length ?? 0) < 500) {
        await this.consentCurrent(context);
        return events;
      }
    }
    throw new Error(
      "Operational history replay limit exceeded; checkpoint required.",
    );
  }
}

/** Sole operational bus: append before publication; both projections replay this
 * same ordered journal. The memory adapter is used only without optional consent. */
export class OperationalBus {
  private failures = new Set<string>();
  constructor(
    private readonly journal: OperationalJournal = new SupabaseOperationalJournal(),
  ) {}
  async read(context: OperationalContext) {
    if (!context.sessionId || !context.consent)
      return {
        state: operationalState.read(context.scope),
        history: operationalState.history(context.scope),
        durability: "not_consented" as const,
      };
    const history = await this.journal.load(context);
    let state = createOperationalState(context.scope);
    const seen = new Set<string>();
    for (const event of history) {
      if (
        event.scope.userId !== context.scope.userId ||
        event.scope.organizationId !== context.scope.organizationId ||
        event.scope.siteId !== context.scope.siteId ||
        event.sessionId !== context.sessionId ||
        event.crewId !== null
      )
        throw new OperationalAccessError("Journal provenance mismatch.");
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      state = reduceOperationalEvent(state, event);
    }
    return {
      state,
      history,
      durability: this.failures.has(context.sessionId)
        ? ("unavailable" as const)
        : ("durable" as const),
    };
  }
  async publish(context: OperationalContext, input: EventInput) {
    if (!context.sessionId || !context.consent) {
      operationalState.publish(context.scope, input);
      return;
    }
    const event = OperationalEventSchema.parse({
      ...operationalProvenance(input),
      id: randomUUID(),
      version: 1,
      sequence: 1,
      scope: context.scope,
      sessionId: context.sessionId,
    });
    try {
      await this.journal.append(context, event);
      // A later successful append cannot repair a gap left by an earlier
      // failed transition. Keep this process's diagnostic sticky for the session.
    } catch (error) {
      if (this.failures.size >= 1000)
        this.failures.delete(this.failures.values().next().value!);
      this.failures.add(context.sessionId);
      throw error;
    }
  }
}
export const operationalBus = new OperationalBus();

export function operationalPublisher(req: Request) {
  const context = resolveIdentity(req).then((identity) => {
    if (
      !identity ||
      identity.classification !== "resolved" ||
      identity.isPresentation ||
      identity.userId !== req.userId
    )
      return null;
    return resolveOperationalContext(req, identity);
  });
  // Attach a rejection handler immediately; observers must never create an
  // unhandled rejection if a request ends before its first publication.
  const resolved = context.catch((error) => {
    req.log?.warn({ err: error }, "Operational context unavailable");
    return null;
  });
  return async (input: EventInput) => {
    const value = await resolved;
    if (value) await operationalBus.publish(value, input);
  };
}
