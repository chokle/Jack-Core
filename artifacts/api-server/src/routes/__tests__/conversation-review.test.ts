import express, { type Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const identity = vi.hoisted(() => ({
  userId: "pilot-admin",
  email: "admin@example.test",
  name: "Pilot Admin",
  isAdmin: false,
  isPresentation: false,
  classification: "resolved",
}));

vi.mock("../../lib/supabase.js", async () => {
  const mocks = await import("../../lib/__tests__/mocks.js");
  return { supabase: { from: mocks.fake.from.bind(mocks.fake) } };
});
vi.mock("../../lib/admin-auth.js", () => ({
  resolveIdentity: vi.fn(async () => ({ ...identity })),
}));

import { fake, resetMocks } from "../../lib/__tests__/mocks.js";
import conversationReviewRouter from "../conversation-review.js";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const PILOT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ORGANIZATION_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_PILOT_ID = "44444444-4444-4444-8444-444444444444";
const query = `organizationId=${ORGANIZATION_ID}&pilotId=${PILOT_ID}`;

function app(): Express {
  const value = express();
  value.use(express.json());
  value.use((req, _res, next) => {
    (req as never as { log: { error: ReturnType<typeof vi.fn> } }).log = {
      error: vi.fn(),
    };
    next();
  });
  value.use("/api", conversationReviewRouter);
  return value;
}

beforeEach(() => {
  resetMocks();
  Object.assign(identity, {
    userId: "pilot-admin",
    isPresentation: false,
    classification: "resolved",
  });
  fake.tables.organizations = [
    { id: ORGANIZATION_ID, name: "Allowed Org", status: "active" },
    { id: OTHER_ORGANIZATION_ID, name: "Other Org", status: "active" },
  ];
  fake.tables.pilots = [
    {
      id: PILOT_ID,
      organization_id: ORGANIZATION_ID,
      name: "Pilot",
      status: "active",
    },
    {
      id: OTHER_PILOT_ID,
      organization_id: OTHER_ORGANIZATION_ID,
      name: "Other",
      status: "active",
    },
  ];
  fake.tables.pilot_memberships = [
    {
      user_id: "pilot-admin",
      organization_id: ORGANIZATION_ID,
      pilot_id: PILOT_ID,
      role: "pilot_admin",
      active: true,
      valid_from: "2026-01-01T00:00:00.000Z",
      valid_until: null,
    },
  ];
  fake.tables.platform_roles = [];
  fake.tables.admin_access_audit = [];
  fake.tables.conversation_review_consents = [
    {
      id: "55555555-5555-4555-8555-555555555555",
      actor_user_id: "tester-1",
      organization_id: ORGANIZATION_ID,
      pilot_id: PILOT_ID,
      chat_session_id: "historic-session",
      state: "granted",
      privacy_notice_version: "jack-pilot-privacy-2026-07-25",
      consent_version: "jack-pilot-conversation-review-addendum-2026-08-11",
      occurred_at: "2026-08-11T10:00:00.000Z",
      created_at: "2026-08-11T10:00:00.000Z",
    },
  ];
  fake.tables.test_sessions = [];
  fake.tables.chat_messages = [
    {
      id: "personal-question",
      user_id: "tester-1",
      session_id: "personal-session",
      role: "user",
      content: "Private personal question",
      citations: [],
      created_at: "2026-07-30T11:00:00.000Z",
    },
    {
      id: "old-question",
      user_id: "tester-1",
      session_id: "historic-session",
      role: "user",
      content: "Historical question before consent",
      citations: [],
      created_at: "2026-08-01T10:00:00.000Z",
    },
    {
      id: "old-answer",
      user_id: "tester-1",
      session_id: "historic-session",
      role: "assistant",
      content: "Historical answer",
      citations: [{ videoTitle: "Safety briefing", startTime: 12 }],
      created_at: "2026-08-01T10:00:01.000Z",
    },
    {
      id: "other-question",
      user_id: "tester-2",
      session_id: "other-session",
      role: "user",
      content: "Must stay private",
      citations: [],
      created_at: "2026-08-01T11:00:00.000Z",
    },
  ];
});

describe("pilot conversation review", () => {
  it("returns preserved canonical history only for currently consented scoped participants", async () => {
    const response = await request(app()).get(
      `/api/testing/conversation-review?${query}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.body.conversations).toEqual([
      {
        participantId: "tester-1",
        askedAt: "2026-08-01T10:00:00.000Z",
        respondedAt: "2026-08-01T10:00:01.000Z",
        question: "Historical question before consent",
        response: "Historical answer",
        citations: [{ videoTitle: "Safety briefing", startTime: 12 }],
      },
    ]);
    expect(JSON.stringify(response.body)).not.toContain("Must stay private");
    expect(JSON.stringify(response.body)).not.toContain(
      "Private personal question",
    );
    expect(fake.tables.admin_access_audit.at(-1)).toMatchObject({
      action: "conversation_review.read",
      decision: "allowed",
      authority: "pilot_admin",
    });
  });

  it("removes access immediately when a same-timestamp withdrawal is the latest scoped choice", async () => {
    fake.tables.conversation_review_consents.push({
      id: "66666666-6666-4666-8666-666666666666",
      actor_user_id: "tester-1",
      organization_id: ORGANIZATION_ID,
      pilot_id: PILOT_ID,
      chat_session_id: "historic-session",
      state: "withdrawn",
      privacy_notice_version: "jack-pilot-privacy-2026-07-25",
      consent_version: "jack-pilot-conversation-review-addendum-2026-08-11",
      occurred_at: "2026-08-11T10:00:00.000Z",
      created_at: "2026-08-11T10:00:01.000Z",
    });

    const response = await request(app()).get(
      `/api/testing/conversation-review?${query}`,
    );

    expect(response.status).toBe(200);
    expect(response.body.conversations).toEqual([]);
  });

  it("pages through all consent rows instead of silently truncating participants", async () => {
    fake.tables.conversation_review_consents = [
      ...Array.from({ length: 2_000 }, (_, index) => ({
        id: `recent-decline-${String(index).padStart(4, "0")}`,
        actor_user_id: `declined-tester-${index}`,
        organization_id: ORGANIZATION_ID,
        pilot_id: PILOT_ID,
        chat_session_id: `declined-session-${index}`,
        state: "declined",
        privacy_notice_version: "jack-pilot-privacy-2026-07-25",
        consent_version: "jack-pilot-conversation-review-addendum-2026-08-11",
        occurred_at: "2026-08-12T10:00:00.000Z",
        created_at: "2026-08-12T10:00:00.000Z",
      })),
      {
        id: "paged-grant",
        actor_user_id: "tester-paged",
        organization_id: ORGANIZATION_ID,
        pilot_id: PILOT_ID,
        chat_session_id: "paged-session",
        state: "granted",
        privacy_notice_version: "jack-pilot-privacy-2026-07-25",
        consent_version: "jack-pilot-conversation-review-addendum-2026-08-11",
        occurred_at: "2026-08-11T09:00:00.000Z",
        created_at: "2026-08-11T09:00:00.000Z",
      },
    ];
    fake.tables.chat_messages = [
      {
        id: "paged-question",
        user_id: "tester-paged",
        session_id: "paged-session",
        role: "user",
        content: "Question beyond the old consent cap",
        citations: [],
        created_at: "2026-08-11T09:01:00.000Z",
      },
    ];

    const response = await request(app()).get(
      `/api/testing/conversation-review?${query}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.body.conversations).toEqual([
      expect.objectContaining({
        participantId: "tester-paged",
        question: "Question beyond the old consent cap",
      }),
    ]);
  });

  it("keeps expired-consent messages as product history but excludes detached rows from review", async () => {
    fake.tables.conversation_review_consents = [
      {
        id: "expired-review-grant",
        actor_user_id: "tester-1",
        organization_id: ORGANIZATION_ID,
        pilot_id: PILOT_ID,
        chat_session_id: "old-scoped-session",
        state: "granted",
        privacy_notice_version: "jack-pilot-privacy-2026-07-25",
        consent_version: "jack-pilot-conversation-review-addendum-2026-08-11",
        occurred_at: "2026-08-01T10:00:00.000Z",
        created_at: "2026-08-01T10:00:00.000Z",
      },
      {
        id: "current-review-grant",
        actor_user_id: "tester-1",
        organization_id: ORGANIZATION_ID,
        pilot_id: PILOT_ID,
        chat_session_id: "current-session",
        state: "granted",
        privacy_notice_version: "jack-pilot-privacy-2026-07-25",
        consent_version: "jack-pilot-conversation-review-addendum-2026-08-11",
        occurred_at: "2026-08-12T10:00:00.000Z",
        created_at: "2026-08-12T10:00:00.000Z",
      },
    ];
    fake.tables.chat_messages = [
      {
        id: "detached-question",
        user_id: "tester-1",
        session_id: "old-scoped-session",
        organization_id: ORGANIZATION_ID,
        pilot_id: PILOT_ID,
        conversation_review_consent_id: "expired-review-grant",
        role: "user",
        content: "Canonical history no longer reviewable",
        citations: [],
        created_at: "2026-08-01T10:01:00.000Z",
      },
    ];

    await fake
      .from("conversation_review_consents")
      .delete()
      .eq("id", "expired-review-grant");
    const response = await request(app()).get(
      `/api/testing/conversation-review?${query}`,
    );

    expect(
      fake.tables.conversation_review_consents.some(
        (row) => row["id"] === "expired-review-grant",
      ),
    ).toBe(false);
    expect(
      fake.tables.conversation_review_consents.some(
        (row) => row["id"] === "current-review-grant",
      ),
    ).toBe(true);
    expect(fake.tables.chat_messages).toEqual([
      expect.objectContaining({
        id: "detached-question",
        conversation_review_consent_id: null,
        content: "Canonical history no longer reviewable",
      }),
    ]);
    expect(response.status).toBe(200);
    expect(response.body.conversations).toEqual([]);
  });

  it("excludes messages linked to an older withdrawn grant after consent is re-granted", async () => {
    fake.tables.conversation_review_consents = [
      {
        id: "old-review-grant",
        actor_user_id: "tester-1",
        organization_id: ORGANIZATION_ID,
        pilot_id: PILOT_ID,
        chat_session_id: "old-scoped-session",
        state: "granted",
        privacy_notice_version: "jack-pilot-privacy-2026-07-25",
        consent_version: "jack-pilot-conversation-review-addendum-2026-08-11",
        occurred_at: "2026-08-01T10:00:00.000Z",
        created_at: "2026-08-01T10:00:00.000Z",
      },
      {
        id: "review-withdrawal",
        actor_user_id: "tester-1",
        organization_id: ORGANIZATION_ID,
        pilot_id: PILOT_ID,
        chat_session_id: "old-scoped-session",
        state: "withdrawn",
        privacy_notice_version: "jack-pilot-privacy-2026-07-25",
        consent_version: "jack-pilot-conversation-review-addendum-2026-08-11",
        occurred_at: "2026-08-05T10:00:00.000Z",
        created_at: "2026-08-05T10:00:00.000Z",
      },
      {
        id: "current-review-grant",
        actor_user_id: "tester-1",
        organization_id: ORGANIZATION_ID,
        pilot_id: PILOT_ID,
        chat_session_id: "current-scoped-session",
        state: "granted",
        privacy_notice_version: "jack-pilot-privacy-2026-07-25",
        consent_version: "jack-pilot-conversation-review-addendum-2026-08-11",
        occurred_at: "2026-08-12T10:00:00.000Z",
        created_at: "2026-08-12T10:00:00.000Z",
      },
    ];
    fake.tables.chat_messages = [
      {
        id: "old-linked-question",
        user_id: "tester-1",
        session_id: "old-scoped-session",
        organization_id: ORGANIZATION_ID,
        pilot_id: PILOT_ID,
        conversation_review_consent_id: "old-review-grant",
        role: "user",
        content: "Question from the withdrawn grant",
        citations: [],
        created_at: "2026-08-02T10:00:00.000Z",
      },
      {
        id: "current-linked-question",
        user_id: "tester-1",
        session_id: "current-scoped-session",
        organization_id: ORGANIZATION_ID,
        pilot_id: PILOT_ID,
        conversation_review_consent_id: "current-review-grant",
        role: "user",
        content: "Question from the current grant",
        citations: [],
        created_at: "2026-08-12T10:01:00.000Z",
      },
      {
        id: "current-linked-answer",
        user_id: "tester-1",
        session_id: "current-scoped-session",
        organization_id: ORGANIZATION_ID,
        pilot_id: PILOT_ID,
        conversation_review_consent_id: "current-review-grant",
        role: "assistant",
        content: "Answer under the current grant",
        citations: [],
        created_at: "2026-08-12T10:01:01.000Z",
      },
    ];

    const response = await request(app()).get(
      `/api/testing/conversation-review?${query}`,
    );

    expect(response.status).toBe(200);
    expect(response.body.conversations).toEqual([
      expect.objectContaining({
        participantId: "tester-1",
        question: "Question from the current grant",
        response: "Answer under the current grant",
      }),
    ]);
    expect(JSON.stringify(response.body)).not.toContain(
      "Question from the withdrawn grant",
    );
  });

  it("orders merged historical and scoped rows by parsed timestamps", async () => {
    fake.tables.chat_messages = [
      {
        id: "offset-question",
        user_id: "tester-1",
        session_id: "historic-session",
        role: "user",
        content: "Offset-aware question",
        citations: [],
        created_at: "2026-08-01T10:00:00.000Z",
      },
      {
        id: "offset-answer",
        user_id: "tester-1",
        session_id: "historic-session",
        organization_id: ORGANIZATION_ID,
        pilot_id: PILOT_ID,
        conversation_review_consent_id: "55555555-5555-4555-8555-555555555555",
        role: "assistant",
        content: "Offset-aware answer",
        citations: [],
        created_at: "2026-08-01T09:00:01.000-01:00",
      },
    ];

    const response = await request(app()).get(
      `/api/testing/conversation-review?${query}`,
    );

    expect(response.body.conversations).toEqual([
      expect.objectContaining({
        question: "Offset-aware question",
        response: "Offset-aware answer",
      }),
    ]);
  });

  it("allows organization and platform admins only through existing scoped report authorization", async () => {
    fake.tables.pilot_memberships[0] = {
      ...fake.tables.pilot_memberships[0],
      role: "organization_admin",
      pilot_id: null,
    };
    expect(
      (await request(app()).get(`/api/testing/conversation-review?${query}`))
        .status,
    ).toBe(200);

    fake.tables.pilot_memberships = [];
    expect(
      (
        await request(app()).get(
          `/api/testing/conversation-review?organizationId=${OTHER_ORGANIZATION_ID}&pilotId=${OTHER_PILOT_ID}`,
        )
      ).status,
    ).toBe(403);
    expect(fake.tables.admin_access_audit.at(-1)).toMatchObject({
      decision: "denied",
    });

    fake.tables.platform_roles = [
      {
        id: "platform-role",
        user_id: "pilot-admin",
        role: "platform_superadmin",
        active: true,
      },
    ];
    expect(
      (
        await request(app()).get(
          `/api/testing/conversation-review?organizationId=${OTHER_ORGANIZATION_ID}&pilotId=${OTHER_PILOT_ID}`,
        )
      ).status,
    ).toBe(200);
    expect(fake.tables.admin_access_audit.at(-1)).toMatchObject({
      decision: "allowed",
      authority: "platform_superadmin",
    });
  });
});
