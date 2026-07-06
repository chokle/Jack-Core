/**
 * Guards the fake Supabase's foreign-key modeling beyond `knowledge_edges` (see
 * edge-upsert-notnull.test.ts for that one). The real schema
 * (`scripts/src/supabase-schema.sql`) enforces several more FKs that, when a
 * child row is written before its parent, 500 in production the same invisible
 * way an orphan edge used to. These tests assert the fake rejects those orphans
 * — on BOTH the `.insert()` and `.upsert()` write paths — so any route/pipeline
 * regression that emits a child before its parent surfaces as a test failure.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { FakeSupabase } from "./fake-supabase.js";

let fake: FakeSupabase;

beforeEach(() => {
  fake = new FakeSupabase();
});

describe("fake-supabase foreign-key modeling — transcript_segments -> videos", () => {
  it("rejects an inserted segment whose video_id has no matching videos row", async () => {
    const { error } = await fake
      .from("transcript_segments")
      .insert({ id: "seg-1", video_id: "missing", text: "hi", start_time: 0, end_time: 1 });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/foreign key constraint "transcript_segments_video_id_fkey"/);
    expect(error!.message).toMatch(/is not present in table "videos"/);
    expect(fake.tables["transcript_segments"].some((r) => r["id"] === "seg-1")).toBe(false);
  });

  it("accepts an inserted segment once its video exists", async () => {
    fake.tables["videos"].push({ id: "v-1", title: "Weld basics" });
    const { error } = await fake
      .from("transcript_segments")
      .insert({ id: "seg-1", video_id: "v-1", text: "hi", start_time: 0, end_time: 1 });
    expect(error).toBeNull();
    expect(fake.tables["transcript_segments"].some((r) => r["id"] === "seg-1")).toBe(true);
  });

  it("rejects an upserted segment whose video_id is missing (upsert path too)", async () => {
    const { error } = await fake
      .from("transcript_segments")
      .upsert({ id: "seg-2", video_id: "missing", text: "hi", start_time: 0, end_time: 1 }, { onConflict: "id" });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/foreign key constraint "transcript_segments_video_id_fkey"/);
    expect(fake.tables["transcript_segments"].some((r) => r["id"] === "seg-2")).toBe(false);
  });
});

describe("fake-supabase foreign-key modeling — interview_sessions -> mentor_profiles", () => {
  it("rejects an inserted session whose mentor_profile_id is missing", async () => {
    const { error } = await fake
      .from("interview_sessions")
      .insert({ id: "s-1", mentor_profile_id: "missing", trade: "Welder" });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/foreign key constraint "interview_sessions_mentor_profile_id_fkey"/);
    expect(error!.message).toMatch(/is not present in table "mentor_profiles"/);
  });

  it("accepts an inserted session once its mentor exists", async () => {
    fake.tables["mentor_profiles"] = [{ id: "m-1", name: "Alice" }];
    const { error } = await fake
      .from("interview_sessions")
      .insert({ id: "s-1", mentor_profile_id: "m-1", trade: "Welder" });
    expect(error).toBeNull();
  });
});

describe("fake-supabase foreign-key modeling — interview_answers -> sessions + mentors", () => {
  beforeEach(() => {
    fake.tables["mentor_profiles"] = [{ id: "m-1", name: "Alice" }];
    fake.tables["interview_sessions"] = [{ id: "s-1", mentor_profile_id: "m-1" }];
  });

  it("rejects an answer whose session_id is missing", async () => {
    const { error } = await fake
      .from("interview_answers")
      .insert({ id: "a-1", session_id: "missing", mentor_profile_id: "m-1", question: "q?" });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/foreign key constraint "interview_answers_session_id_fkey"/);
  });

  it("rejects an answer whose mentor_profile_id is missing", async () => {
    const { error } = await fake
      .from("interview_answers")
      .insert({ id: "a-1", session_id: "s-1", mentor_profile_id: "missing", question: "q?" });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/foreign key constraint "interview_answers_mentor_profile_id_fkey"/);
  });

  it("accepts an answer once both its session and mentor exist", async () => {
    const { error } = await fake
      .from("interview_answers")
      .insert({ id: "a-1", session_id: "s-1", mentor_profile_id: "m-1", question: "q?" });
    expect(error).toBeNull();
  });

  it("rejects an upserted answer whose session_id is missing (upsert path too)", async () => {
    const { error } = await fake
      .from("interview_answers")
      .upsert({ id: "a-2", session_id: "missing", mentor_profile_id: "m-1", question: "q?" }, { onConflict: "id" });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/foreign key constraint "interview_answers_session_id_fkey"/);
    expect(fake.tables["interview_answers"].some((r) => r["id"] === "a-2")).toBe(false);
  });
});

describe("fake-supabase foreign-key modeling — parked_thoughts (nullable FKs)", () => {
  it("allows a chat-sourced parked thought with NULL interview/mentor FKs", async () => {
    // chat rows carry only chat_session_id; the interview/mentor FKs are NULL and
    // must NOT trip the FK check (a NULL is allowed by the real nullable FK).
    const { error } = await fake.from("parked_thoughts").insert({
      id: "p-1",
      source: "chat",
      chat_session_id: "sess-abc",
      title: "t",
      summary: "s",
    });
    expect(error).toBeNull();
  });

  it("rejects an interview-sourced parked thought whose interview_session_id is missing", async () => {
    const { error } = await fake.from("parked_thoughts").insert({
      id: "p-2",
      source: "interview",
      interview_session_id: "missing",
      title: "t",
      summary: "s",
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/foreign key constraint "parked_thoughts_interview_session_id_fkey"/);
  });
});
