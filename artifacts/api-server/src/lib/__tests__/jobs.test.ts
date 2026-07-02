import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Guard tests for the resilient job system: a server restart must never strand
 * a video in an in-flight status. These exercise the recovery sweep's
 * classification/reclaim logic and the pipeline's durable failure handling
 * against the in-memory fake Supabase.
 */

vi.mock("../supabase.js", async () => {
  const m = await import("./mocks.js");
  return { supabase: m.fake };
});

vi.mock("../openai.js", async () => {
  const m = await import("./mocks.js");
  return {
    createEmbedding: m.createEmbedding,
    createEmbeddings: async (texts: string[]) =>
      Promise.all(texts.map((t) => m.createEmbedding(t))),
    MODELS: m.MODELS,
    openai: m.openai,
  };
});

const { verifyAndRecordGraphWrite } = vi.hoisted(() => ({
  verifyAndRecordGraphWrite: vi.fn(),
}));
vi.mock("../memory-graph.js", () => ({
  syncVideoGraph: vi.fn(),
  removeVideoGraph: vi.fn(),
  verifyAndRecordGraphWrite,
}));

const { transcribeFromUrl } = vi.hoisted(() => ({ transcribeFromUrl: vi.fn() }));
vi.mock("../transcription.js", () => ({ transcribeFromUrl }));

const { runDistillation } = vi.hoisted(() => ({ runDistillation: vi.fn() }));
vi.mock("../distillation.js", () => ({ runDistillation }));

import {
  INSTANCE_ID,
  MAX_ATTEMPTS,
  UPLOADING_TTL_MS,
  backoffDelayMs,
  recoverJobs,
  runPipeline,
} from "../jobs.js";
import { fake, openai, resetMocks } from "./mocks.js";

const createCompletion = vi.fn();
(openai as { chat: { completions: { create: typeof createCompletion } } }).chat = {
  completions: { create: createCompletion },
};

const NOW = new Date("2026-07-02T12:00:00Z");
const iso = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();

function seedVideo(row: Record<string, unknown>): Record<string, unknown> {
  const full = {
    title: "Test Video",
    trade: "Welder",
    video_url: "https://example.com/v.mp4",
    transcript: null,
    analysis: null,
    attempts: 0,
    claimed_by: null,
    heartbeat_at: null,
    next_attempt_at: null,
    processing_stage: null,
    created_at: iso(60_000),
    ...row,
  };
  fake.tables["videos"]!.push(full);
  return full;
}

function video(id: string): Record<string, unknown> {
  return fake.tables["videos"]!.find((v) => v["id"] === id)!;
}

function goodCompletion() {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            analysis: "Solid analysis.",
            keyPoints: ["a", "b"],
            competencyCodes: ["W-2"],
          }),
        },
      },
    ],
  };
}

beforeEach(() => {
  resetMocks();
  transcribeFromUrl.mockReset();
  runDistillation.mockReset();
  runDistillation.mockResolvedValue(undefined);
  verifyAndRecordGraphWrite.mockReset();
  verifyAndRecordGraphWrite.mockResolvedValue({ status: "verified", checks: {}, summary: "ok" });
  createCompletion.mockReset();
});

describe("backoffDelayMs", () => {
  it("doubles from 30s and caps at 5 minutes", () => {
    expect(backoffDelayMs(1)).toBe(30_000);
    expect(backoffDelayMs(2)).toBe(60_000);
    expect(backoffDelayMs(3)).toBe(120_000);
    expect(backoffDelayMs(10)).toBe(300_000);
  });
});

describe("recoverJobs — orphaned and stale in-flight rows", () => {
  it("reclaims a row orphaned by a previous instance and resumes its stage once", async () => {
    seedVideo({
      id: "v1",
      status: "transcribing",
      processing_stage: "transcribing",
      claimed_by: "api-previous-life",
      heartbeat_at: iso(10 * 60_000),
      attempts: 0,
    });
    const run = vi.fn();

    const decisions = await recoverJobs({ now: NOW, run });

    expect(decisions).toEqual([
      expect.objectContaining({
        videoId: "v1",
        classification: "orphaned",
        action: "resume",
        stage: "transcribing",
      }),
    ]);
    expect(run).toHaveBeenCalledExactlyOnceWith("v1", "transcribing");
    const row = video("v1");
    expect(row["claimed_by"]).toBe(INSTANCE_ID);
    // Resuming a crashed run consumes an attempt so a crash-loop cannot spin forever.
    expect(row["attempts"]).toBe(1);
  });

  it("skips a row we own ourselves with a fresh heartbeat (job is genuinely running)", async () => {
    seedVideo({
      id: "v1",
      status: "analyzing",
      processing_stage: "analyzing",
      claimed_by: INSTANCE_ID,
      heartbeat_at: iso(10_000),
    });
    const run = vi.fn();

    const decisions = await recoverJobs({ now: NOW, run });

    expect(decisions[0]).toMatchObject({ classification: "active", action: "skip" });
    expect(run).not.toHaveBeenCalled();
    expect(video("v1")["attempts"]).toBe(0);
  });

  it("reclaims our own row when the heartbeat is stale (the runner died silently)", async () => {
    seedVideo({
      id: "v1",
      status: "indexing",
      processing_stage: "indexing",
      claimed_by: INSTANCE_ID,
      heartbeat_at: iso(6 * 60_000),
      attempts: 1,
    });
    const run = vi.fn();

    const decisions = await recoverJobs({ now: NOW, run });

    expect(decisions[0]).toMatchObject({
      classification: "stale",
      action: "resume",
      stage: "indexing",
    });
    expect(run).toHaveBeenCalledExactlyOnceWith("v1", "indexing");
    expect(video("v1")["attempts"]).toBe(2);
  });

  it("fails an orphaned row whose attempts are already exhausted instead of crash-looping", async () => {
    seedVideo({
      id: "v1",
      status: "transcribing",
      processing_stage: "transcribing",
      claimed_by: "api-previous-life",
      heartbeat_at: iso(30 * 60_000),
      attempts: MAX_ATTEMPTS,
    });
    const run = vi.fn();

    const decisions = await recoverJobs({ now: NOW, run });

    expect(decisions[0]).toMatchObject({ classification: "exhausted", action: "fail" });
    expect(run).not.toHaveBeenCalled();
    const row = video("v1");
    expect(row["status"]).toBe("failed");
    expect(row["last_error"]).toMatch(/attempts are exhausted/);
  });
});

describe("recoverJobs — uploading and uploaded", () => {
  it("leaves a recent client upload alone (server cannot resume it)", async () => {
    seedVideo({ id: "v1", status: "uploading", heartbeat_at: iso(5 * 60_000) });
    const run = vi.fn();

    const decisions = await recoverJobs({ now: NOW, run });

    expect(decisions[0]).toMatchObject({
      classification: "upload-in-progress",
      action: "skip",
    });
    expect(run).not.toHaveBeenCalled();
    expect(video("v1")["status"]).toBe("uploading");
  });

  it("fails an uploading row older than the TTL — the client is gone", async () => {
    seedVideo({ id: "v1", status: "uploading", heartbeat_at: iso(UPLOADING_TTL_MS + 60_000) });

    const decisions = await recoverJobs({ now: NOW });

    expect(decisions[0]).toMatchObject({ classification: "upload-expired", action: "fail" });
    const row = video("v1");
    expect(row["status"]).toBe("failed");
    expect(row["last_error"]).toMatch(/Upload never completed/);
  });

  it("starts processing for an uploaded row whose pipeline never began", async () => {
    seedVideo({ id: "v1", status: "uploaded" });
    const run = vi.fn();

    const decisions = await recoverJobs({ now: NOW, run });

    expect(decisions[0]).toMatchObject({
      classification: "uploaded-never-started",
      action: "resume",
      stage: "transcribing",
    });
    expect(run).toHaveBeenCalledExactlyOnceWith("v1", "transcribing");
  });
});

describe("recoverJobs — retrying rows", () => {
  it("waits while the backoff has not elapsed", async () => {
    seedVideo({
      id: "v1",
      status: "retrying",
      processing_stage: "analyzing",
      next_attempt_at: new Date(NOW.getTime() + 60_000).toISOString(),
      transcript: "t",
    });
    const run = vi.fn();

    const decisions = await recoverJobs({ now: NOW, run });

    expect(decisions[0]).toMatchObject({ classification: "retry-waiting", action: "skip" });
    expect(run).not.toHaveBeenCalled();
  });

  it("resumes a due retry at its recorded stage", async () => {
    seedVideo({
      id: "v1",
      status: "retrying",
      processing_stage: "analyzing",
      next_attempt_at: iso(1_000),
      transcript: "t",
      attempts: 1,
    });
    const run = vi.fn();

    const decisions = await recoverJobs({ now: NOW, run });

    expect(decisions[0]).toMatchObject({
      classification: "retry-due",
      action: "resume",
      stage: "analyzing",
    });
    expect(run).toHaveBeenCalledExactlyOnceWith("v1", "analyzing");
    expect(video("v1")["status"]).toBe("analyzing");
  });
});

describe("runPipeline — durable failure handling", () => {
  it("schedules a capped-backoff retry on a transient stage failure", async () => {
    seedVideo({ id: "v1", status: "transcribing", attempts: 0 });
    transcribeFromUrl.mockRejectedValue(new Error("network hiccup"));

    await runPipeline("v1", "transcribing");

    const row = video("v1");
    expect(row["status"]).toBe("retrying");
    expect(row["processing_stage"]).toBe("transcribing");
    expect(row["attempts"]).toBe(1);
    expect(row["last_error"]).toBe("network hiccup");
    expect(row["claimed_by"]).toBeNull();
    expect(row["next_attempt_at"]).toBeTruthy();
  });

  it("fails immediately on an unretryable error (no media URL)", async () => {
    seedVideo({ id: "v1", status: "transcribing", video_url: null });

    await runPipeline("v1", "transcribing");

    const row = video("v1");
    expect(row["status"]).toBe("failed");
    expect(row["last_error"]).toMatch(/no media URL/);
    expect(transcribeFromUrl).not.toHaveBeenCalled();
  });

  it("re-running the transcribe stage never duplicates transcript segments", async () => {
    seedVideo({ id: "v1", status: "transcribing" });
    transcribeFromUrl.mockResolvedValue({
      text: "full transcript",
      segments: [
        { start: 0, end: 5, text: "hello" },
        { start: 5, end: 10, text: "world" },
      ],
    });
    createCompletion.mockResolvedValue(goodCompletion());

    await runPipeline("v1", "transcribing");
    await runPipeline("v1", "transcribing");

    const segs = fake.tables["transcript_segments"]!.filter((s) => s["video_id"] === "v1");
    expect(segs).toHaveLength(2);
    expect(video("v1")["status"]).toBe("completed");
  });

  it("continues to completion when analysis attempts are exhausted (transcript stays usable)", async () => {
    seedVideo({
      id: "v1",
      status: "analyzing",
      transcript: "a perfectly good transcript",
      attempts: MAX_ATTEMPTS - 1,
    });
    createCompletion.mockRejectedValue(new Error("model unavailable"));

    await runPipeline("v1", "analyzing");

    const row = video("v1");
    expect(row["status"]).toBe("completed");
    expect(row["analysis"]).toBeNull();
    // Completion resets the retry bookkeeping.
    expect(row["attempts"]).toBe(0);
    expect(row["last_error"]).toBeNull();
  });

  it("resets attempts and clears claim on success", async () => {
    seedVideo({ id: "v1", status: "analyzing", transcript: "t", attempts: 2 });
    createCompletion.mockResolvedValue(goodCompletion());

    await runPipeline("v1", "analyzing");

    const row = video("v1");
    expect(row["status"]).toBe("completed");
    expect(row["attempts"]).toBe(0);
    expect(row["claimed_by"]).toBeNull();
    expect(row["processing_stage"]).toBeNull();
    expect(row["analysis"]).toBe("Solid analysis.");
  });
});

describe("runPipeline — strict knowledge-write verification at indexing", () => {
  const manifest = {
    scope: "video" as const,
    refId: "v1",
    sourceNodeId: "video:v1",
    expectedNodeIds: ["k:concept:root-opening"],
    expectedEdgeIds: [],
    embeddingNodeIds: [],
  };

  it("completes only when the knowledge write verifies", async () => {
    seedVideo({ id: "v1", status: "analyzing", transcript: "t", attempts: 0 });
    createCompletion.mockResolvedValue(goodCompletion());
    runDistillation.mockResolvedValue(manifest);
    verifyAndRecordGraphWrite.mockResolvedValue({ status: "verified", checks: {}, summary: "ok" });

    await runPipeline("v1", "analyzing");

    expect(verifyAndRecordGraphWrite).toHaveBeenCalledTimes(1);
    expect(video("v1")["status"]).toBe("completed");
  });

  it("never reports completed — it retries — when the write is only partial", async () => {
    seedVideo({ id: "v1", status: "analyzing", transcript: "t", attempts: 0 });
    createCompletion.mockResolvedValue(goodCompletion());
    runDistillation.mockResolvedValue(manifest);
    verifyAndRecordGraphWrite.mockResolvedValue({
      status: "partial",
      checks: {},
      summary: "nodesExist: 1 of 1 concept node(s) missing",
    });

    await runPipeline("v1", "analyzing");

    const row = video("v1");
    expect(row["status"]).toBe("retrying");
    expect(row["processing_stage"]).toBe("indexing");
    expect(row["attempts"]).toBe(1);
    expect(row["last_error"]).toMatch(/verification partial/);
  });

  it("flags the video as failed when the write stays unverified and attempts are exhausted", async () => {
    seedVideo({ id: "v1", status: "analyzing", transcript: "t", attempts: MAX_ATTEMPTS - 1 });
    createCompletion.mockResolvedValue(goodCompletion());
    runDistillation.mockResolvedValue(manifest);
    verifyAndRecordGraphWrite.mockResolvedValue({
      status: "failed",
      checks: {},
      summary: "nothing landed",
    });

    await runPipeline("v1", "analyzing");

    const row = video("v1");
    expect(row["status"]).toBe("failed");
    expect(row["last_error"]).toMatch(/verification failed/);
  });

  it("is an honest no-op (completes) when there was nothing to distill", async () => {
    seedVideo({ id: "v1", status: "analyzing", transcript: "t", attempts: 0 });
    createCompletion.mockResolvedValue(goodCompletion());
    runDistillation.mockResolvedValue(null);

    await runPipeline("v1", "analyzing");

    expect(verifyAndRecordGraphWrite).not.toHaveBeenCalled();
    expect(video("v1")["status"]).toBe("completed");
  });
});
