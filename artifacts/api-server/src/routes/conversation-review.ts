import { Router, type Request, type Response } from "express";
import { resolveIdentity } from "../lib/admin-auth.js";
import {
  activityDb as db,
  auditReportAccess,
  authorizeReportScope,
  requestIdentifier,
  type PilotScope,
} from "../lib/activity-telemetry.js";
import {
  CONVERSATION_REVIEW_CONSENT_VERSION,
  currentConversationReviewConsent,
} from "../lib/conversation-review.js";
import { denyRestrictedIdentity } from "../lib/identity.js";

const router = Router();
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CHAT_ROWS = 1_000;
const ACTION = "conversation_review.read";

interface AuthorizedScope extends PilotScope {
  authority: "pilot_admin" | "organization_admin" | "platform_superadmin";
  userId: string;
}

async function requireConversationReviewScope(
  req: Request,
  res: Response,
): Promise<AuthorizedScope | null> {
  const identity = await resolveIdentity(req);
  if (!identity) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  const organizationId =
    typeof req.query["organizationId"] === "string"
      ? req.query["organizationId"]
      : "";
  const pilotId =
    typeof req.query["pilotId"] === "string" ? req.query["pilotId"] : "";

  if (
    denyRestrictedIdentity(
      res,
      identity,
      "Conversation review is unavailable in presentation mode.",
      "Conversation review is temporarily unavailable.",
    )
  ) {
    await auditReportAccess({
      userId: identity.userId,
      organizationId: UUID_RE.test(organizationId) ? organizationId : null,
      pilotId: UUID_RE.test(pilotId) ? pilotId : null,
      action: ACTION,
      decision: "denied",
      requestId: requestIdentifier(req),
    });
    return null;
  }

  const authorization = await authorizeReportScope(
    identity.userId,
    organizationId,
    pilotId,
  );
  await auditReportAccess({
    userId: identity.userId,
    organizationId: UUID_RE.test(organizationId) ? organizationId : null,
    pilotId: UUID_RE.test(pilotId) ? pilotId : null,
    action: ACTION,
    decision: authorization.allowed ? "allowed" : "denied",
    authority: authorization.authority,
    requestId: requestIdentifier(req),
  });
  if (!authorization.allowed || !authorization.authority) {
    res.status(403).json({
      error: "No active report role exists for this organization and pilot.",
    });
    return null;
  }
  return {
    userId: identity.userId,
    organizationId,
    pilotId,
    authority: authorization.authority as AuthorizedScope["authority"],
  };
}

function currentConsentedParticipants(
  rows: Array<Record<string, unknown>>,
): Array<{ participantId: string; chatSessionId: string }> {
  const latest = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const userId = String(row["actor_user_id"] ?? "");
    if (userId && !latest.has(userId)) latest.set(userId, row);
  }
  return [...latest.entries()]
    .filter(([, row]) =>
      currentConversationReviewConsent({
        id: String(row["id"]),
        state: row["state"] as "granted" | "declined" | "withdrawn",
        privacyNoticeVersion: String(row["privacy_notice_version"]),
        consentVersion: String(row["consent_version"]),
        occurredAt: String(row["occurred_at"]),
      }),
    )
    .map(([participantId, row]) => ({
      participantId,
      chatSessionId: String(row["chat_session_id"] ?? ""),
    }))
    .filter((entry) => entry.chatSessionId.length > 0);
}

function serializeExchanges(rows: Array<Record<string, unknown>>) {
  const pending = new Map<string, Record<string, unknown>>();
  const exchanges: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const participantId = String(row["user_id"] ?? "");
    const sessionId = String(row["session_id"] ?? "");
    const key = `${participantId}:${sessionId}`;
    if (row["role"] === "user") {
      const prior = pending.get(key);
      if (prior) exchanges.push(prior);
      pending.set(key, {
        participantId,
        askedAt: row["created_at"],
        respondedAt: null,
        question: row["content"],
        response: null,
        citations: [],
      });
    } else if (row["role"] === "assistant") {
      const question = pending.get(key);
      if (!question) continue;
      question["respondedAt"] = row["created_at"];
      question["response"] = row["content"];
      question["citations"] = Array.isArray(row["citations"])
        ? row["citations"]
        : [];
      exchanges.push(question);
      pending.delete(key);
    }
  }
  exchanges.push(...pending.values());
  return exchanges;
}

router.get("/testing/conversation-review", async (req, res) => {
  try {
    const scope = await requireConversationReviewScope(req, res);
    if (!scope) return;

    const consents = await db
      .from("conversation_review_consents")
      .select(
        "id,actor_user_id,state,privacy_notice_version,consent_version,occurred_at,chat_session_id",
      )
      .eq("organization_id", scope.organizationId)
      .eq("pilot_id", scope.pilotId)
      .order("occurred_at", { ascending: false })
      .limit(2_000);
    if (consents.error) throw consents.error;
    const consentedParticipants = currentConsentedParticipants(
      (consents.data ?? []) as Array<Record<string, unknown>>,
    );
    const participantIds = consentedParticipants.map(
      (entry) => entry.participantId,
    );
    if (participantIds.length === 0) {
      res.setHeader("Cache-Control", "no-store");
      return res.json({ conversations: [], truncated: false });
    }

    // The consent row records the server-owned chat cookie active when the
    // addendum was accepted. This preserves pre-grant history from that
    // conversation only, without exposing unrelated personal/other-pilot chats.
    const historicalSessionIds = consentedParticipants.map(
      (entry) => entry.chatSessionId,
    );
    const allowedHistoricalPairs = new Set(
      consentedParticipants.map(
        (entry) => `${entry.participantId}:${entry.chatSessionId}`,
      ),
    );
    const messageColumns =
      "user_id,session_id,role,content,citations,created_at";
    const [historicalMessages, scopedMessages] = await Promise.all([
      historicalSessionIds.length > 0
        ? db
            .from("chat_messages")
            .select(messageColumns)
            .in("user_id", participantIds)
            .in("session_id", historicalSessionIds)
            .is("organization_id", null)
            .is("pilot_id", null)
            .order("created_at", { ascending: true })
            .limit(MAX_CHAT_ROWS + 1)
        : Promise.resolve({ data: [], error: null }),
      db
        .from("chat_messages")
        .select(messageColumns)
        .in("user_id", participantIds)
        .eq("organization_id", scope.organizationId)
        .eq("pilot_id", scope.pilotId)
        .order("created_at", { ascending: true })
        .limit(MAX_CHAT_ROWS + 1),
    ]);
    if (historicalMessages.error) throw historicalMessages.error;
    if (scopedMessages.error) throw scopedMessages.error;
    const rows = [
      ...(
        (historicalMessages.data ?? []) as Array<Record<string, unknown>>
      ).filter((row) =>
        allowedHistoricalPairs.has(
          `${String(row["user_id"])}:${String(row["session_id"])}`,
        ),
      ),
      ...((scopedMessages.data ?? []) as Array<Record<string, unknown>>),
    ].sort((left, right) =>
      String(left["created_at"] ?? "").localeCompare(
        String(right["created_at"] ?? ""),
      ),
    );
    res.setHeader("Cache-Control", "private, no-store");
    return res.json({
      conversations: serializeExchanges(rows.slice(0, MAX_CHAT_ROWS)),
      truncated: rows.length > MAX_CHAT_ROWS,
      consentVersion: CONVERSATION_REVIEW_CONSENT_VERSION,
    });
  } catch (error) {
    req.log.error(
      { err: error },
      "Could not load consented pilot conversations",
    );
    if (res.headersSent) return;
    return res
      .status(503)
      .json({ error: "Conversation review is temporarily unavailable." });
  }
});

export default router;
