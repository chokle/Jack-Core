import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../supabase.js", async () => {
  const mocks = await import("./mocks.js");
  return { supabase: mocks.fake };
});
vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import {
  deliverFeedbackNotification,
  type FeedbackEmailSender,
} from "../feedback-notifications.js";
import { fake, resetMocks } from "./mocks.js";

const FEEDBACK_ID = "11111111-1111-4111-8111-111111111111";

function seedFeedback() {
  fake.tables["test_feedback"] = [
    {
      id: FEEDBACK_ID,
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
    },
  ];
}

beforeEach(() => {
  resetMocks();
  seedFeedback();
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
});
