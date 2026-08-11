import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../../../supabase/migrations/20260811190035_add_conversation_review_consent.sql",
    import.meta.url,
  ),
  "utf8",
).toLowerCase();

describe("conversation review migration privacy and integrity", () => {
  it("keeps consent separate from canonical chat content and locks browser roles out", () => {
    expect(migration).toContain(
      "create table public.conversation_review_consents",
    );
    expect(migration).not.toMatch(/^\s+(content|question|answer|citations)\s/m);
    expect(migration).toContain(
      "alter table public.conversation_review_consents enable row level security",
    );
    expect(migration).toContain(
      "revoke all on table public.conversation_review_consents from anon, authenticated",
    );
  });

  it("binds stamped chat rows to matching current owner, pilot, consent, and test session", () => {
    expect(migration).toContain(
      "add column conversation_review_consent_id uuid",
    );
    expect(migration).toContain("consent.actor_user_id = new.user_id");
    expect(migration).toContain(
      "consent.organization_id = new.organization_id",
    );
    expect(migration).toContain("consent.pilot_id = new.pilot_id");
    expect(migration).toContain("consent.chat_session_id = new.session_id");
    expect(migration).toContain("consent.state = 'granted'");
    expect(migration).toContain("session.actor_user_id = new.user_id");
    expect(migration).toContain(
      "order by latest.occurred_at desc, latest.created_at desc, latest.id desc",
    );
  });

  it("records the server chat session on pilot sessions and consent", () => {
    expect(migration).toContain("chat_session_id text not null");
    expect(migration).toContain("alter table public.test_sessions");
    expect(migration).toContain("add column chat_session_id text");
  });
});
