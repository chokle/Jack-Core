import {
  activityDb as db,
  PRIVACY_NOTICE_VERSION,
  resolveActiveTesterScope,
} from "./activity-telemetry.js";

export const CONVERSATION_REVIEW_CONSENT_VERSION =
  "jack-pilot-conversation-review-addendum-2026-08-11";

export interface ConversationReviewConsentSnapshot {
  id: string;
  state: "granted" | "declined" | "withdrawn";
  privacyNoticeVersion: string;
  consentVersion: string;
  occurredAt: string;
  chatSessionId?: string;
}

export function currentConversationReviewConsent(
  consent: ConversationReviewConsentSnapshot | null,
): consent is ConversationReviewConsentSnapshot {
  return Boolean(
    consent?.state === "granted" &&
    consent.privacyNoticeVersion === PRIVACY_NOTICE_VERSION &&
    consent.consentVersion === CONVERSATION_REVIEW_CONSENT_VERSION,
  );
}

export async function latestConversationReviewConsent(
  userId: string,
  pilotId: string,
): Promise<ConversationReviewConsentSnapshot | null> {
  const result = await db
    .from("conversation_review_consents")
    .select(
      "id,state,privacy_notice_version,consent_version,occurred_at,chat_session_id",
    )
    .eq("actor_user_id", userId)
    .eq("pilot_id", pilotId)
    .order("occurred_at", { ascending: false })
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (result.error) throw result.error;
  if (!result.data) return null;
  return {
    id: String(result.data.id),
    state: result.data.state as ConversationReviewConsentSnapshot["state"],
    privacyNoticeVersion: String(result.data.privacy_notice_version),
    consentVersion: String(result.data.consent_version),
    occurredAt: String(result.data.occurred_at),
    chatSessionId: String(result.data.chat_session_id),
  };
}

export interface ConversationReviewLinkage {
  organization_id: string;
  pilot_id: string;
  test_session_id: string | null;
  conversation_review_consent_id: string;
}

/**
 * Finds the participant's most recently granted, still-current pilot addendum.
 * The linkage is metadata on canonical product history, never a content copy.
 */
export async function currentConversationReviewLinkage(
  userId: string,
  chatSessionId: string,
): Promise<ConversationReviewLinkage | null> {
  const history = await db
    .from("conversation_review_consents")
    .select(
      "id,state,privacy_notice_version,consent_version,occurred_at,organization_id,pilot_id,chat_session_id",
    )
    .eq("actor_user_id", userId)
    .order("occurred_at", { ascending: false })
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1000);
  if (history.error) throw history.error;

  const latestByPilot = new Map<string, Record<string, unknown>>();
  for (const row of (history.data ?? []) as Array<Record<string, unknown>>) {
    const pilotId = String(row["pilot_id"] ?? "");
    if (pilotId && !latestByPilot.has(pilotId)) latestByPilot.set(pilotId, row);
  }

  const eligible: ConversationReviewLinkage[] = [];
  for (const row of latestByPilot.values()) {
    const snapshot: ConversationReviewConsentSnapshot = {
      id: String(row["id"]),
      state: row["state"] as ConversationReviewConsentSnapshot["state"],
      privacyNoticeVersion: String(row["privacy_notice_version"]),
      consentVersion: String(row["consent_version"]),
      occurredAt: String(row["occurred_at"]),
      chatSessionId: String(row["chat_session_id"]),
    };
    if (
      !currentConversationReviewConsent(snapshot) ||
      snapshot.chatSessionId !== chatSessionId
    )
      continue;

    const pilotId = String(row["pilot_id"]);
    const membership = await resolveActiveTesterScope(userId, pilotId);
    if (!membership.scope) continue;

    const session = await db
      .from("test_sessions")
      .select("id")
      .eq("actor_user_id", userId)
      .eq("organization_id", membership.scope.organizationId)
      .eq("pilot_id", pilotId)
      .eq("chat_session_id", chatSessionId)
      .eq("status", "active")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (session.error) throw session.error;

    eligible.push({
      organization_id: membership.scope.organizationId,
      pilot_id: pilotId,
      test_session_id: session.data ? String(session.data.id) : null,
      conversation_review_consent_id: snapshot.id,
    });
  }
  return eligible.length === 1 ? eligible[0]! : null;
}
