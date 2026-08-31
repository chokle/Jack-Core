import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../supabase.js", async () => {
  const mocks = await import("./mocks.js");
  return { supabase: mocks.fake };
});
vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import {
  deliverFeedbackNotification,
  queueFeedbackNotification,
  type FeedbackEmailSender,
} from "../feedback-notifications.js";
import { fake, resetMocks } from "./mocks.js";

const FEEDBACK_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "tester-feedback-1";
const PILOT_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const CONSENT_ID = "44444444-4444-4444-8444-444444444444";

function seedFeedback() {
  fake.tables["test_feedback"] = [
    {
      id: FEEDBACK_ID,
      tester_user_id: ACTOR_ID,
      pilot_id: PILOT_ID,
      test_session_id: SESSION_ID,
      tester_name: "Taylor Tester",
      tester_trade: "Electrical",
      useful: "partly",
      shortfall: "Needed a clearer source.",
      additional: "Add more Canadian examples.",
      features_used: ["ask_jack", "memory_graph"],
      device_category: "desktop",
      trigger: "logout",
      created_at: "2026-07-23T00:00:00.000Z",
      notification_status: "pending",
      notification_attempts: 0,
      notification_next_attempt_at: null,
      deletion_due_at: null,
    },
  ];
}

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  resetMocks();
  seedFeedback();
  fake.tables["telemetry_withdrawal_jobs"] = [];
  fake.tables["telemetry_consents"] = [{
    id: CONSENT_ID,
    actor_user_id: ACTOR_ID,
    pilot_id: PILOT_ID,
    scope: "telemetry",
    state: "granted",
    occurred_at: "2026-07-23T00:00:00.000Z",
  }];
  fake.tables["test_sessions"] = [{
    id: SESSION_ID,
    actor_user_id: ACTOR_ID,
    pilot_id: PILOT_ID,
    telemetry_status: "granted",
    telemetry_consent_id: CONSENT_ID,
    deletion_due_at: null,
  }];
  process.env["PUBLIC_SITE_URL"] = "https://jack.example.test";
  process.env["FEEDBACK_NOTIFICATION_RECIPIENTS"] = "derek@example.test";
  delete process.env["RESEND_API_KEY"];
  delete process.env["FEEDBACK_FROM_EMAIL"];
  vi.unstubAllGlobals();
});

describe("feedback notification delivery", () => {
  it("records a successful immediate delivery", async () => {
    process.env["RESEND_API_KEY"] = "test-key";
    process.env["FEEDBACK_FROM_EMAIL"] = "Jack Feedback <feedback@example.test>";
    const providerFetch = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
      new Response(JSON.stringify({ id: "email-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", providerFetch);

    expect(await deliverFeedbackNotification(FEEDBACK_ID)).toBe("sent");
    expect(providerFetch).toHaveBeenCalledOnce();
    const request = providerFetch.mock.calls[0]?.[1] as RequestInit;
    expect(request.headers).toMatchObject({
      "Idempotency-Key": `jack-feedback-${FEEDBACK_ID}`,
    });
    const body = JSON.parse(String(request.body)) as {
      to: string[];
      text: string;
      html: string;
    };
    expect(body.to).toEqual(["derek@example.test"]);
    expect(body.text).toContain(`/app?view=review&feedback=${FEEDBACK_ID}`);
    expect(body.text).not.toContain("interview answer");
    expect(body.html).not.toContain("private prompt");
    expect(fake.tables["test_feedback"][0]).toMatchObject({
      notification_status: "sent",
      notification_attempts: 1,
      notification_provider_message_id: "email-1",
      notification_last_error: null,
    });
  });

  it("marks a missing email provider configuration failed", async () => {
    const providerFetch = vi.fn();
    vi.stubGlobal("fetch", providerFetch);

    expect(await deliverFeedbackNotification(FEEDBACK_ID)).toBe("failed");
    expect(providerFetch).not.toHaveBeenCalled();
    expect(fake.tables["test_feedback"][0]).toMatchObject({
      notification_status: "failed",
      notification_last_error: "email_provider_not_configured",
    });
  });

  it("marks missing recipient configuration failed without losing feedback", async () => {
    delete process.env["FEEDBACK_NOTIFICATION_RECIPIENTS"];
    const sender = vi.fn<FeedbackEmailSender>(async () => ({ messageId: "should-not-send" }));

    expect(await deliverFeedbackNotification(FEEDBACK_ID, sender)).toBe("failed");
    expect(sender).not.toHaveBeenCalled();
    expect(fake.tables["test_feedback"][0]).toMatchObject({
      id: FEEDBACK_ID,
      notification_status: "failed",
      notification_last_error: "feedback_recipient_not_configured",
    });
  });

  it("records a retryable provider failure and preserves the authoritative row", async () => {
    process.env["RESEND_API_KEY"] = "test-key";
    process.env["FEEDBACK_FROM_EMAIL"] = "Jack Feedback <feedback@example.test>";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));

    expect(await deliverFeedbackNotification(FEEDBACK_ID)).toBe("retrying");
    expect(fake.tables["test_feedback"][0]).toMatchObject({
      id: FEEDBACK_ID,
      additional: "Add more Canadian examples.",
      notification_status: "retrying",
      notification_attempts: 1,
      notification_last_error: "email_provider_http_503",
    });
  });

  it("does not send again after the same feedback id is already sent", async () => {
    const sender = vi.fn<FeedbackEmailSender>(async () => ({ messageId: "email-1" }));

    await deliverFeedbackNotification(FEEDBACK_ID, sender);
    await deliverFeedbackNotification(FEEDBACK_ID, sender);

    expect(sender).toHaveBeenCalledOnce();
    expect(fake.tables["test_feedback"][0]?.["notification_attempts"]).toBe(1);
  });

  it("does not deliver feedback in a terminal failed state", async () => {
    fake.tables["test_feedback"][0]!["notification_status"] = "failed";
    const sender = vi.fn<FeedbackEmailSender>(async () => ({ messageId: "must-not-send" }));

    expect(await deliverFeedbackNotification(FEEDBACK_ID, sender)).toBe("failed");

    expect(sender).not.toHaveBeenCalled();
    expect(fake.tables["test_feedback"][0]?.["notification_attempts"]).toBe(0);
  });

  it("fails closed when feedback is marked for deletion", async () => {
    fake.tables["test_feedback"][0]!["deletion_due_at"] =
      "2026-07-30T00:00:00.000Z";
    const sender = vi.fn<FeedbackEmailSender>(async () => ({ messageId: "must-not-send" }));

    expect(await deliverFeedbackNotification(FEEDBACK_ID, sender)).toBe("failed");

    expect(sender).not.toHaveBeenCalled();
    expect(fake.tables["test_feedback"][0]).toMatchObject({
      notification_status: "pending",
      notification_attempts: 0,
      deletion_due_at: "2026-07-30T00:00:00.000Z",
    });
  });

  it("suppresses pending feedback after consent append while cleanup is retrying", async () => {
    fake.tables["telemetry_withdrawal_jobs"] = [{
      id: "55555555-5555-4555-8555-555555555555",
      actor_user_id: ACTOR_ID,
      pilot_id: PILOT_ID,
      status: "retrying",
    }];
    fake.tables["telemetry_consents"].push({
      id: "66666666-6666-4666-8666-666666666666",
      actor_user_id: ACTOR_ID,
      pilot_id: PILOT_ID,
      scope: "telemetry",
      state: "withdrawn",
      occurred_at: "2026-07-24T00:00:00.000Z",
    });
    const sender = vi.fn<FeedbackEmailSender>(async () => ({
      messageId: "must-not-send",
    }));

    expect(await deliverFeedbackNotification(FEEDBACK_ID, sender)).toBe("failed");

    expect(sender).not.toHaveBeenCalled();
    expect(fake.tables["test_feedback"][0]).toMatchObject({
      notification_status: "failed",
      notification_attempts: 0,
      notification_last_error: "telemetry_consent_withdrawn",
      notification_next_attempt_at: null,
      deletion_due_at: null,
    });
  });

  it("suppresses delivery as soon as a withdrawal obligation is staged", async () => {
    fake.tables["telemetry_withdrawal_jobs"] = [{
      id: "77777777-7777-4777-8777-777777777777",
      actor_user_id: ACTOR_ID,
      pilot_id: PILOT_ID,
      status: "awaiting_consent",
    }];
    const sender = vi.fn<FeedbackEmailSender>(async () => ({
      messageId: "must-not-send",
    }));

    expect(await deliverFeedbackNotification(FEEDBACK_ID, sender)).toBe("failed");
    expect(sender).not.toHaveBeenCalled();
    expect(fake.tables["test_feedback"][0]).toMatchObject({
      notification_status: "failed",
      notification_last_error: "telemetry_consent_withdrawn",
    });
  });

  it("preserves withdrawal state when delivery finishes after withdrawal", async () => {
    const sender = vi.fn<FeedbackEmailSender>(async () => {
      Object.assign(fake.tables["test_feedback"][0]!, {
        notification_status: "failed",
        notification_last_error: "telemetry_consent_withdrawn",
        notification_next_attempt_at: null,
        deletion_due_at: "2026-07-30T00:00:00.000Z",
      });
      return { messageId: "email-in-flight" };
    });

    expect(await deliverFeedbackNotification(FEEDBACK_ID, sender)).toBe("failed");

    expect(sender).toHaveBeenCalledOnce();
    expect(fake.tables["test_feedback"][0]).toMatchObject({
      notification_status: "failed",
      notification_attempts: 0,
      notification_last_error: "telemetry_consent_withdrawn",
      deletion_due_at: "2026-07-30T00:00:00.000Z",
    });
  });

  it("re-checks withdrawal state before queued setImmediate delivery", async () => {
    process.env["RESEND_API_KEY"] = "test-key";
    process.env["FEEDBACK_FROM_EMAIL"] = "Jack Feedback <feedback@example.test>";
    const providerFetch = vi.fn(async () =>
      new Response(JSON.stringify({ id: "must-not-send" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", providerFetch);
    vi.useFakeTimers();

    queueFeedbackNotification(FEEDBACK_ID);
    Object.assign(fake.tables["test_feedback"][0]!, {
      notification_status: "failed",
      notification_last_error: "telemetry_consent_withdrawn",
      notification_next_attempt_at: null,
      deletion_due_at: "2026-07-30T00:00:00.000Z",
    });
    await vi.runAllTimersAsync();

    expect(providerFetch).not.toHaveBeenCalled();
    expect(fake.tables["test_feedback"][0]).toMatchObject({
      notification_status: "failed",
      notification_attempts: 0,
      notification_last_error: "telemetry_consent_withdrawn",
      deletion_due_at: "2026-07-30T00:00:00.000Z",
    });
  });
});
