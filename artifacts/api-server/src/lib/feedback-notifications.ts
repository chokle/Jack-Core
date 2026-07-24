import { randomUUID } from "node:crypto";
import { supabase } from "./supabase.js";
import { logger } from "./logger.js";

type NotificationState = "pending" | "sent" | "failed" | "retrying";

interface FeedbackRow {
  id: string;
  tester_name: string | null;
  tester_trade: string | null;
  useful: "yes" | "partly" | "no";
  shortfall: string;
  additional: string | null;
  features_used: string[];
  device_category: string;
  trigger: string;
  created_at: string;
  notification_status: NotificationState;
  notification_attempts: number;
  notification_next_attempt_at: string | null;
}

interface DeliveryResult {
  messageId: string | null;
}

export type FeedbackEmailSender = (
  feedback: FeedbackRow,
  recipients: string[],
  recordUrl: string,
) => Promise<DeliveryResult>;

const INSTANCE_ID = `feedback-${randomUUID()}`;
const MAX_ATTEMPTS = 3;
const SWEEP_INTERVAL_MS = 60_000;
const inFlight = new Set<string>();

class DeliveryError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = "DeliveryError";
  }
}

function configuredRecipients(): string[] {
  return (process.env["FEEDBACK_NOTIFICATION_RECIPIENTS"] ?? "")
    .split(/[,\s]+/)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function feedbackRecordUrl(feedbackId: string): string {
  const siteUrl = process.env["PUBLIC_SITE_URL"];
  if (!siteUrl) throw new DeliveryError("public_site_url_not_configured", false);
  const url = new URL("/app", siteUrl);
  url.searchParams.set("view", "review");
  url.searchParams.set("feedback", feedbackId);
  return url.toString();
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function excerpt(value: string | null | undefined, max = 500): string {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

async function sendWithResend(
  feedback: FeedbackRow,
  recipients: string[],
  recordUrl: string,
): Promise<DeliveryResult> {
  const apiKey = process.env["RESEND_API_KEY"];
  const from = process.env["FEEDBACK_FROM_EMAIL"];
  if (!apiKey) throw new DeliveryError("email_provider_not_configured", false);
  if (!from) throw new DeliveryError("feedback_from_email_not_configured", false);

  const tester = excerpt(feedback.tester_name, 120) || "Signed-in tester";
  const trade = excerpt(feedback.tester_trade, 120) || "Not provided";
  const writtenFeedback = excerpt(feedback.additional || feedback.shortfall);
  const features = feedback.features_used.join(", ") || "Not recorded";
  const usefulness = feedback.useful === "yes" ? "Yes" : feedback.useful === "partly" ? "Partly" : "No";
  const subject = `[Jack feedback] ${usefulness} — ${trade}`;
  const text = [
    "New Jack user-test feedback",
    `Tester: ${tester}`,
    `Trade: ${trade}`,
    `Usefulness: ${usefulness}`,
    `Feedback: ${writtenFeedback || "No additional comment"}`,
    `Features: ${features}`,
    `Device: ${feedback.device_category}`,
    `Trigger: ${feedback.trigger}`,
    `Submitted: ${feedback.created_at}`,
    "",
    `Review securely: ${recordUrl}`,
  ].join("\n");
  const html = [
    "<h2>New Jack user-test feedback</h2>",
    `<p><strong>Tester:</strong> ${escapeHtml(tester)}<br>`,
    `<strong>Trade:</strong> ${escapeHtml(trade)}<br>`,
    `<strong>Usefulness:</strong> ${escapeHtml(usefulness)}<br>`,
    `<strong>Feedback:</strong> ${escapeHtml(writtenFeedback || "No additional comment")}<br>`,
    `<strong>Features:</strong> ${escapeHtml(features)}<br>`,
    `<strong>Device:</strong> ${escapeHtml(feedback.device_category)}<br>`,
    `<strong>Trigger:</strong> ${escapeHtml(feedback.trigger)}<br>`,
    `<strong>Submitted:</strong> ${escapeHtml(feedback.created_at)}</p>`,
    `<p><a href="${escapeHtml(recordUrl)}">Open this feedback in Jack Review</a></p>`,
  ].join("");

  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `jack-feedback-${feedback.id}`,
      },
      body: JSON.stringify({ from, to: recipients, subject, text, html }),
    });
  } catch {
    throw new DeliveryError("email_provider_network_error", true);
  }

  if (!response.ok) {
    throw new DeliveryError(
      `email_provider_http_${response.status}`,
      response.status === 429 || response.status >= 500,
    );
  }
  const body = (await response.json().catch(() => ({}))) as { id?: unknown };
  return { messageId: typeof body.id === "string" ? body.id : null };
}

function retryDelayMs(attempts: number): number {
  return Math.min(60_000 * 5 ** Math.max(0, attempts - 1), 15 * 60_000);
}

function errorCode(error: unknown): { code: string; retryable: boolean } {
  if (error instanceof DeliveryError) {
    return { code: error.code, retryable: error.retryable };
  }
  return { code: "email_delivery_unexpected_error", retryable: true };
}

export async function deliverFeedbackNotification(
  feedbackId: string,
  sender: FeedbackEmailSender = sendWithResend,
): Promise<NotificationState> {
  if (inFlight.has(feedbackId)) return "retrying";
  inFlight.add(feedbackId);
  try {
    const { data, error } = await supabase
      .from("test_feedback")
      .select(
        "id,tester_name,tester_trade,useful,shortfall,additional,features_used,device_category,trigger,created_at,notification_status,notification_attempts,notification_next_attempt_at",
      )
      .eq("id", feedbackId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return "failed";
    const feedback = data as FeedbackRow;
    if (feedback.notification_status === "sent") return "sent";

    const now = new Date();
    if (
      feedback.notification_next_attempt_at &&
      new Date(feedback.notification_next_attempt_at).getTime() > now.getTime()
    ) {
      return feedback.notification_status;
    }

    const attempts = (feedback.notification_attempts ?? 0) + 1;
    try {
      const recipients = configuredRecipients();
      if (recipients.length === 0) {
        throw new DeliveryError("feedback_recipient_not_configured", false);
      }
      const result = await sender(feedback, recipients, feedbackRecordUrl(feedback.id));
      const { error: updateError } = await supabase
        .from("test_feedback")
        .update({
          notification_status: "sent",
          notification_attempts: attempts,
          notification_last_error: null,
          notification_last_attempt_at: now.toISOString(),
          notification_next_attempt_at: null,
          notification_sent_at: now.toISOString(),
          notification_provider_message_id: result.messageId,
          updated_at: now.toISOString(),
        })
        .eq("id", feedback.id);
      if (updateError) throw updateError;
      logger.info(
        { feedbackId: feedback.id, notificationStatus: "sent", attempts },
        "feedback notification sent",
      );
      return "sent";
    } catch (error) {
      const failure = errorCode(error);
      const retrying = failure.retryable && attempts < MAX_ATTEMPTS;
      const status: NotificationState = retrying ? "retrying" : "failed";
      const nextAttempt = retrying
        ? new Date(now.getTime() + retryDelayMs(attempts)).toISOString()
        : null;
      const { error: updateError } = await supabase
        .from("test_feedback")
        .update({
          notification_status: status,
          notification_attempts: attempts,
          notification_last_error: failure.code,
          notification_last_attempt_at: now.toISOString(),
          notification_next_attempt_at: nextAttempt,
          updated_at: now.toISOString(),
        })
        .eq("id", feedback.id);
      if (updateError) {
        logger.error(
          { err: updateError, feedbackId: feedback.id, notificationStatus: status },
          "failed to record feedback notification state",
        );
      }
      logger.error(
        {
          feedbackId: feedback.id,
          notificationStatus: status,
          attempts,
          errorCode: failure.code,
        },
        "feedback notification delivery failed",
      );
      return status;
    }
  } catch (error) {
    logger.error(
      { err: error, feedbackId, instanceId: INSTANCE_ID },
      "feedback notification worker failed",
    );
    return "failed";
  } finally {
    inFlight.delete(feedbackId);
  }
}

export function queueFeedbackNotification(feedbackId: string): void {
  setImmediate(() => {
    void deliverFeedbackNotification(feedbackId);
  });
}

export async function sweepFeedbackNotifications(): Promise<void> {
  const { data, error } = await supabase
    .from("test_feedback")
    .select("id,notification_next_attempt_at")
    .in("notification_status", ["pending", "retrying"])
    .order("created_at", { ascending: true })
    .limit(25);
  if (error) {
    logger.error({ err: error }, "feedback notification sweep failed");
    return;
  }
  const now = Date.now();
  for (const row of data ?? []) {
    const next = row.notification_next_attempt_at
      ? new Date(row.notification_next_attempt_at as string).getTime()
      : 0;
    if (next <= now) queueFeedbackNotification(row.id as string);
  }
}

export function startFeedbackNotificationWorker(): void {
  void sweepFeedbackNotifications();
  const timer = setInterval(() => void sweepFeedbackNotifications(), SWEEP_INTERVAL_MS);
  timer.unref?.();
}
