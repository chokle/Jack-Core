/**
 * Resilient video-processing job system.
 *
 * Jobs still run in-process (no queue infrastructure — see
 * docs/upload-scalability-design.md), but ALL job state is durable on the
 * videos row: status, processing_stage, attempts, last_error, heartbeat_at,
 * claimed_by, next_attempt_at. A server restart therefore never strands a
 * video in an in-flight status — the startup recovery sweep (and a runtime
 * watchdog) reclaims orphaned/stale rows and resumes them from the start of
 * their stage.
 *
 * Status lifecycle:
 *   queued → uploading → uploaded → transcribing → analyzing → indexing → completed
 * with `failed` (terminal, last_error recorded) and `retrying` (waiting for a
 * capped-backoff re-attempt of the failed stage).
 *
 * Stage idempotency contract (what makes resuming safe):
 *   - transcribing: transcript overwrites; segments are delete-then-insert per video
 *   - analyzing:    analysis/key_points/competency_codes overwrite
 *   - indexing:     embeddings overwrite per row; graph sync reconciles by deterministic IDs
 * Resuming restarts the STAGE, never mid-stage.
 */

import { randomUUID } from "node:crypto";
import { supabase } from "./supabase.js";
import { chatCompletion, createEmbedding, createEmbeddings, MODELS } from "./openai.js";
import { trackJob, trackMemoryWrite } from "./vitality.js";
import { logger } from "./logger.js";
import { transcribeFromUrl } from "./transcription.js";
import { syncVideoGraph, removeVideoGraph, verifyAndRecordGraphWrite } from "./memory-graph.js";
import { runDistillation } from "./distillation.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Unique per process life — lets a new instance tell "claimed by a previous life" apart. */
export const INSTANCE_ID = `api-${randomUUID()}`;

export type Stage = "transcribing" | "analyzing" | "indexing";

export const STAGE_ORDER: Stage[] = ["transcribing", "analyzing", "indexing"];

/** Server-side in-flight statuses — a crash in one of these must be recoverable. */
export const IN_FLIGHT_STATUSES: readonly string[] = STAGE_ORDER;

/** Statuses a new processing run may claim from (manual retry included). */
export const CLAIMABLE_STATUSES: readonly string[] = [
  "queued",
  "uploading",
  "uploaded",
  "failed",
  "retrying",
];

export const MAX_ATTEMPTS = 3;

/** Hard per-stage timeouts: a hung OpenAI/network call cannot strand a video. */
export const STAGE_TIMEOUT_MS: Record<Stage, number> = {
  transcribing: 30 * 60_000,
  analyzing: 5 * 60_000,
  indexing: 15 * 60_000,
};

/**
 * Per-stage heartbeat staleness thresholds. Heartbeats are written every
 * HEARTBEAT_INTERVAL_MS while a stage runs, so anything older than these means
 * the process running the job died (restart/OOM), not that it is slow.
 */
export const STAGE_STALE_MS: Record<Stage, number> = {
  transcribing: 5 * 60_000,
  analyzing: 5 * 60_000,
  indexing: 5 * 60_000,
};

export const HEARTBEAT_INTERVAL_MS = 30_000;

/** `uploading` is client-driven — the server cannot resume it. Generous TTL, then fail. */
export const UPLOADING_TTL_MS = 2 * 60 * 60_000;

export const WATCHDOG_INTERVAL_MS = 60_000;

/** Exponential backoff between retry attempts: 30s, 60s, 120s… capped at 5 min. */
export function backoffDelayMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 5 * 60_000);
}

/** A failure that will not succeed on retry (missing media, corrupt input…). */
export class UnretryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnretryableError";
  }
}

// ---------------------------------------------------------------------------
// Best-effort derived-view wrappers (graph mirror + distillation)
// ---------------------------------------------------------------------------

/**
 * Best-effort mirror of a video into the persisted knowledge graph. The graph is
 * a derived view, so a sync failure must never fail (or roll back) the underlying
 * video operation — we log and move on; GET /graph self-heals from source tables.
 */
export async function syncGraphSafe(videoId: string): Promise<void> {
  try {
    await syncVideoGraph(videoId);
  } catch (err) {
    logger.error({ err, videoId }, "knowledge graph sync failed");
  }
}

export async function removeGraphSafe(videoId: string): Promise<void> {
  try {
    await removeVideoGraph(videoId);
  } catch (err) {
    logger.error({ err, videoId }, "knowledge graph node removal failed");
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Strip HTML tags so prompt-injected markup in LLM output is never stored,
 * regardless of how the value is later rendered (defense-in-depth; the client
 * already renders as text).
 */
function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, "").trim();
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} stage timed out after ${Math.round(ms / 1000)}s`)),
      ms,
    );
    timer.unref?.();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** Periodic progress heartbeat while a stage runs. Returns a stop function. */
function startHeartbeat(videoId: string): () => void {
  const timer = setInterval(() => {
    void (async () => {
      await supabase
        .from("videos")
        .update({ heartbeat_at: new Date().toISOString() })
        .eq("id", videoId)
        .eq("claimed_by", INSTANCE_ID);
    })().catch(() => {
      /* best-effort */
    });
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

/**
 * Atomically claim a video for a processing run starting at `stage`. The
 * conditional UPDATE only matches rows in one of `from` statuses, so
 * concurrent/duplicate enqueues are no-ops (Postgres row-locks the UPDATE and
 * re-checks the WHERE clause for the loser).
 */
export async function claimStage(
  videoId: string,
  stage: Stage,
  opts: {
    from: readonly string[];
    requireNoTranscript?: boolean;
    requireTranscript?: boolean;
    requireNoAnalysis?: boolean;
  },
): Promise<boolean> {
  let q = supabase
    .from("videos")
    .update({
      status: stage,
      processing_stage: stage,
      claimed_by: INSTANCE_ID,
      heartbeat_at: new Date().toISOString(),
      next_attempt_at: null,
      last_error: null,
    })
    .eq("id", videoId)
    .in("status", [...opts.from]);
  if (opts.requireNoTranscript) q = q.is("transcript", null);
  if (opts.requireTranscript) q = q.not("transcript", "is", null);
  if (opts.requireNoAnalysis) q = q.is("analysis", null);

  const { data } = await q.select("id").maybeSingle();
  return Boolean(data);
}

// ---------------------------------------------------------------------------
// Stage implementations (each safe to re-run from its start)
// ---------------------------------------------------------------------------

async function stageTranscribe(videoId: string): Promise<void> {
  const { data: video } = await supabase
    .from("videos")
    .select("video_url")
    .eq("id", videoId)
    .maybeSingle();

  if (!video?.video_url) {
    throw new UnretryableError("Video has no media URL to transcribe");
  }

  const {
    text: fullTranscript,
    segments: rawSegments,
    durationSeconds,
    thumbnailJpeg,
  } = await transcribeFromUrl(video.video_url as string);

  const segments = rawSegments.map((s) => ({
    video_id: videoId,
    start_time: s.start,
    end_time: s.end,
    text: s.text,
    confidence: null as number | null,
    embedding: null as string | null,
  }));

  // Replace (never append) so a re-run that yields fewer — or zero — segments
  // can never leave stale or duplicated rows behind.
  const { error: delErr } = await supabase
    .from("transcript_segments")
    .delete()
    .eq("video_id", videoId);
  if (delErr) throw delErr;

  const BATCH = 100;
  for (let i = 0; i < segments.length; i += BATCH) {
    const { error: insertErr } = await supabase
      .from("transcript_segments")
      .insert(segments.slice(i, i + BATCH));
    if (insertErr) throw insertErr;
  }

  // Best-effort enrichment: upload the poster frame to the existing public
  // bucket at a deterministic path (upsert => idempotent re-runs) and record
  // duration + thumbnail_url in the SAME update as the transcript. A thumbnail
  // or duration failure must NEVER fail transcription — a usable transcript is
  // the point of this stage (mirrors the analysis-exhaustion philosophy).
  let thumbnailUrl: string | null = null;
  if (thumbnailJpeg && thumbnailJpeg.length > 0) {
    const thumbPath = `thumbnails/${videoId}.jpg`;
    const { error: thumbErr } = await supabase.storage
      .from("jack-videos")
      .upload(thumbPath, thumbnailJpeg, { contentType: "image/jpeg", upsert: true });
    if (thumbErr) {
      logger.warn({ err: thumbErr, videoId }, "thumbnail upload failed — continuing");
    } else {
      thumbnailUrl = `${process.env["SUPABASE_URL"]}/storage/v1/object/public/jack-videos/${thumbPath}`;
    }
  }

  const videoUpdate: Record<string, unknown> = { transcript: fullTranscript };
  if (durationSeconds != null) videoUpdate["duration"] = durationSeconds;
  if (thumbnailUrl) videoUpdate["thumbnail_url"] = thumbnailUrl;

  const { error: updateErr } = await supabase
    .from("videos")
    .update(videoUpdate)
    .eq("id", videoId);
  if (updateErr) throw updateErr;
}

async function stageAnalyze(videoId: string): Promise<void> {
  const { data: video } = await supabase
    .from("videos")
    .select("transcript, title, trade")
    .eq("id", videoId)
    .maybeSingle();

  if (!video?.transcript) {
    throw new UnretryableError("Video has no transcript to analyze");
  }

  const { data: competencies } = await supabase
    .from("competencies")
    .select("code, name, trade");

  const competencyContext = (competencies ?? [])
    .map((c: Record<string, string>) => `${c["code"]}: ${c["name"]} (${c["trade"]})`)
    .join("\n");

  const completion = await chatCompletion({
    model: MODELS.analysis,
    messages: [
      {
        role: "system",
        content: `You are Jack — an AI assistant specialized in skilled trades training and Red Seal certification. Analyze training video transcripts and map them to Red Seal competencies.\n\nAvailable Red Seal competencies:\n${competencyContext}`,
      },
      {
        role: "user",
        content: `Analyze this training video transcript for "${video.title}" (trade: ${video.trade ?? "general"}).\n\nTranscript:\n${(video.transcript as string).slice(0, 6000)}\n\nRespond with a JSON object:\n{\n  "analysis": "2-3 paragraph summary of what this video teaches",\n  "keyPoints": ["point 1", "point 2", "point 3", "point 4", "point 5"],\n  "competencyCodes": ["CODE1", "CODE2"]\n}`,
      },
    ],
    response_format: { type: "json_object" },
  });

  const result = JSON.parse(completion.choices[0]?.message?.content ?? "{}") as {
    analysis?: unknown;
    keyPoints?: unknown;
    competencyCodes?: unknown;
  };

  // Normalize GPT output before writing — a malformed keyPoints/competencyCodes
  // value would otherwise fail the text[] column write.
  const analysisText =
    typeof result.analysis === "string" ? stripHtml(result.analysis) : null;
  const keyPoints = Array.isArray(result.keyPoints)
    ? result.keyPoints.filter((p): p is string => typeof p === "string").map(stripHtml)
    : [];
  const competencyCodes = Array.isArray(result.competencyCodes)
    ? result.competencyCodes.filter((c): c is string => typeof c === "string")
    : [];

  const { error: writeErr } = await supabase
    .from("videos")
    .update({
      analysis: analysisText,
      key_points: keyPoints,
      competency_codes: competencyCodes,
    })
    .eq("id", videoId);
  if (writeErr) throw writeErr;
}

async function stageIndex(videoId: string): Promise<void> {
  const startedAtMs = Date.now();
  // 1. Embed every transcript segment (overwrites are idempotent) so semantic
  //    search and Ask Jack can match specific moments — this powers citations.
  const { data: segs } = await supabase
    .from("transcript_segments")
    .select("id, text")
    .eq("video_id", videoId);

  const rows = (segs ?? []) as Array<{ id: string; text: string | null }>;
  if (rows.length > 0) {
    const vectors = await createEmbeddings(rows.map((r) => r.text || " "));
    for (let i = 0; i < rows.length; i++) {
      const vec = vectors[i];
      const { error: segErr } = await supabase
        .from("transcript_segments")
        .update({ embedding: vec && vec.length > 0 ? JSON.stringify(vec) : null })
        .eq("id", rows[i]!.id);
      if (segErr) throw segErr;
    }
  }

  // 2. Whole-video embedding (related-videos discovery).
  const { data: video } = await supabase
    .from("videos")
    .select("transcript, attempts")
    .eq("id", videoId)
    .maybeSingle();
  const transcript = ((video?.transcript as string | null) ?? "").trim();
  const attempts =
    typeof video?.attempts === "number" ? (video.attempts as number) + 1 : 1;
  const embeddingVec =
    transcript.length > 0
      ? await createEmbedding(transcript.slice(0, 8000), { cache: false })
      : [];
  const { error: embErr } = await supabase
    .from("videos")
    .update({ embedding: embeddingVec.length > 0 ? JSON.stringify(embeddingVec) : null })
    .eq("id", videoId);
  if (embErr) throw embErr;

  // 3. Mirror the video into the knowledge graph, then distill atomic knowledge,
  //    then VERIFY the knowledge actually landed. Both writes are
  //    reconciling/deterministic, so re-runs collapse onto the same nodes. This
  //    is deliberately NOT best-effort: a video must never report `completed`
  //    while its knowledge silently failed to enter the graph. On a non-verified
  //    verdict we throw, which routes the video through the normal retry ladder
  //    (retry-forward — shared nodes are never rolled back) and, on exhaustion,
  //    leaves it flagged rather than falsely successful.
  await trackMemoryWrite(async () => {
    await syncVideoGraph(videoId);
    const manifest = await runDistillation(videoId);
    if (manifest) {
      const verification = await verifyAndRecordGraphWrite(manifest, { attempts, startedAtMs });
      if (verification.status !== "verified") {
        throw new Error(`Knowledge write verification ${verification.status}: ${verification.summary}`);
      }
    }
  });
}

const STAGE_RUNNERS: Record<Stage, (videoId: string) => Promise<void>> = {
  transcribing: stageTranscribe,
  analyzing: stageAnalyze,
  indexing: stageIndex,
};

const STAGE_FAIL_LOG: Record<Stage, string> = {
  transcribing: "Transcription failed",
  analyzing: "Analysis failed",
  indexing: "Indexing failed",
};

// ---------------------------------------------------------------------------
// Pipeline driver
// ---------------------------------------------------------------------------

async function enterStage(videoId: string, stage: Stage): Promise<void> {
  await supabase
    .from("videos")
    .update({
      status: stage,
      processing_stage: stage,
      claimed_by: INSTANCE_ID,
      heartbeat_at: new Date().toISOString(),
    })
    .eq("id", videoId);
}

async function completePipeline(videoId: string): Promise<void> {
  const { error } = await supabase
    .from("videos")
    .update({
      status: "completed",
      processing_stage: null,
      claimed_by: null,
      next_attempt_at: null,
      attempts: 0,
      last_error: null,
      heartbeat_at: new Date().toISOString(),
    })
    .eq("id", videoId);
  if (error) {
    logger.error({ err: error, videoId }, "failed to write completed status");
  } else {
    logger.info({ videoId }, "video processing completed");
  }
}

/**
 * Record a stage failure durably: transient failures with attempts remaining
 * move the row to `retrying` (with backoff); unretryable failures or exhausted
 * attempts move it to `failed` with last_error.
 *
 * Deliberate exception: the ANALYZING stage is a value-add on top of an
 * already-usable transcript. When it is unretryable or out of attempts, the
 * pipeline continues to indexing instead of failing the video — this preserves
 * the long-standing guarantee that an analysis hiccup never downgrades a
 * successfully transcribed video.
 */
async function handleStageFailure(
  videoId: string,
  stage: Stage,
  err: unknown,
): Promise<"continue" | "stopped"> {
  const { data: row } = await supabase
    .from("videos")
    .select("attempts")
    .eq("id", videoId)
    .maybeSingle();
  const attempts = ((row?.["attempts"] as number | null) ?? 0) + 1;
  const unretryable = err instanceof UnretryableError;
  const exhausted = attempts >= MAX_ATTEMPTS;
  const message = errText(err);

  logger.error({ err, videoId, stage, attempts, unretryable }, STAGE_FAIL_LOG[stage]);

  if (stage === "analyzing" && (unretryable || exhausted)) {
    logger.warn(
      { videoId, attempts },
      "analysis attempts exhausted — continuing without analysis (transcript stays usable)",
    );
    await supabase
      .from("videos")
      .update({ attempts, last_error: message })
      .eq("id", videoId);
    return "continue";
  }

  if (unretryable || exhausted) {
    await supabase
      .from("videos")
      .update({
        status: "failed",
        attempts,
        last_error: message,
        claimed_by: null,
        next_attempt_at: null,
        heartbeat_at: new Date().toISOString(),
      })
      .eq("id", videoId);
    logger.error({ videoId, stage, attempts }, "video processing failed permanently");
    return "stopped";
  }

  const delay = backoffDelayMs(attempts);
  await supabase
    .from("videos")
    .update({
      status: "retrying",
      processing_stage: stage,
      attempts,
      last_error: message,
      claimed_by: null,
      next_attempt_at: new Date(Date.now() + delay).toISOString(),
      heartbeat_at: new Date().toISOString(),
    })
    .eq("id", videoId);
  logger.warn({ videoId, stage, attempts, retryInMs: delay }, "stage failed — retry scheduled");
  return "stopped";
}

/**
 * Run the processing pipeline for a video starting at `fromStage`. The caller
 * must have claimed the row first (claimStage / recovery reclaim) — this
 * function only drives stages forward and records failures durably.
 */
export async function runPipeline(
  videoId: string,
  fromStage: Stage = "transcribing",
): Promise<void> {
  // Report ingestion as heavy activity ("Writing Memory") for the whole run.
  await trackJob(async () => {
    const startIdx = STAGE_ORDER.indexOf(fromStage);
    for (const stage of STAGE_ORDER.slice(startIdx)) {
      await enterStage(videoId, stage);
      logger.info({ videoId, stage }, "pipeline stage started");
      const stopHeartbeat = startHeartbeat(videoId);
      try {
        await withTimeout(STAGE_RUNNERS[stage](videoId), STAGE_TIMEOUT_MS[stage], stage);
      } catch (err) {
        const outcome = await handleStageFailure(videoId, stage, err);
        if (outcome === "stopped") {
          await syncGraphSafe(videoId);
          return;
        }
      } finally {
        stopHeartbeat();
      }
    }
    await completePipeline(videoId);
    await syncGraphSafe(videoId);
  });
}

// ---------------------------------------------------------------------------
// Pipeline concurrency gate. A bulk upload can enqueue dozens of videos at once;
// ungated, each would spawn its own download + ffmpeg + Whisper + embedding work
// simultaneously, exhausting disk/CPU and tripping OpenAI rate limits. Bound the
// number of enqueued pipelines running at once (FIFO). Rows are durable, so
// anything still waiting when the process restarts is picked up by the recovery
// sweep. (Recovery itself resumes through a separate chain already serialized to
// one at a time.)
// ---------------------------------------------------------------------------
const MAX_CONCURRENT_PIPELINES = 2;
let activePipelines = 0;
const pipelineWaiters: Array<() => void> = [];

function acquirePipelineSlot(): Promise<void> {
  if (activePipelines < MAX_CONCURRENT_PIPELINES) {
    activePipelines++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    pipelineWaiters.push(resolve);
  });
}

function releasePipelineSlot(): void {
  // Hand the slot directly to the next waiter (keeps the active count steady) or
  // free it when nobody is queued.
  const next = pipelineWaiters.shift();
  if (next) next();
  else activePipelines--;
}

/** Fire-and-forget enqueue of a pipeline run, bounded by the concurrency gate. */
export function enqueuePipeline(videoId: string, fromStage: Stage = "transcribing"): void {
  setImmediate(async () => {
    // The caller already claimed the row (status flipped to a stage, claimed_by
    // = us). While it waits behind the gate it isn't yet running, so nothing
    // would refresh its heartbeat — keep one alive so the watchdog doesn't
    // classify a healthy, queued video as stale and start a duplicate run. The
    // heartbeat write is scoped to `claimed_by = INSTANCE_ID`, so a run whose
    // claim we lost is a harmless no-op. runPipeline starts its own per-stage
    // heartbeat once we hand off.
    const stopWaitHeartbeat = startHeartbeat(videoId);
    try {
      await acquirePipelineSlot();
    } finally {
      stopWaitHeartbeat();
    }
    try {
      await runPipeline(videoId, fromStage);
    } catch (err: unknown) {
      logger.error({ err, videoId }, "pipeline run crashed outside stage handling");
    } finally {
      releasePipelineSlot();
    }
  });
}

/**
 * Convenience used by the /analyze route and kept as the exported `runAnalysis`
 * surface: runs the pipeline from the analyzing stage onwards (analyzing →
 * indexing → completed). Never rejects.
 */
export async function runAnalysis(videoId: string): Promise<void> {
  try {
    await runPipeline(videoId, "analyzing");
  } catch (err) {
    logger.error({ err, videoId }, "Analysis failed");
  }
}

// ---------------------------------------------------------------------------
// Recovery: startup sweep + runtime watchdog
// ---------------------------------------------------------------------------

export interface RecoveryDecision {
  videoId: string;
  status: string;
  classification:
    | "active"
    | "orphaned"
    | "stale"
    | "exhausted"
    | "upload-expired"
    | "upload-in-progress"
    | "uploaded-never-started"
    | "retry-due"
    | "retry-waiting"
    | "claim-lost";
  action: "resume" | "fail" | "skip";
  stage?: Stage;
}

interface JobRow {
  id: string;
  status: string;
  claimed_by: string | null;
  heartbeat_at: string | null;
  created_at: string | null;
  attempts: number | null;
  next_attempt_at: string | null;
  processing_stage: string | null;
  transcript: string | null;
  analysis: string | null;
}

function inferStage(row: JobRow): Stage {
  const recorded = row.processing_stage as Stage | null;
  if (recorded && STAGE_ORDER.includes(recorded)) return recorded;
  if (!row.transcript) return "transcribing";
  if (!row.analysis) return "analyzing";
  return "indexing";
}

/** Atomic reclaim: only wins if the row still looks exactly as observed. */
async function reclaim(
  row: JobRow,
  stage: Stage,
  now: Date,
  attempts?: number,
): Promise<boolean> {
  const updates: Record<string, unknown> = {
    status: stage,
    processing_stage: stage,
    claimed_by: INSTANCE_ID,
    heartbeat_at: now.toISOString(),
    next_attempt_at: null,
  };
  if (attempts !== undefined) updates["attempts"] = attempts;

  let q = supabase.from("videos").update(updates).eq("id", row.id).eq("status", row.status);
  q = row.claimed_by == null ? q.is("claimed_by", null) : q.eq("claimed_by", row.claimed_by);
  const { data } = await q.select("id").maybeSingle();
  return Boolean(data);
}

async function markFailed(row: JobRow, reason: string): Promise<void> {
  await supabase
    .from("videos")
    .update({
      status: "failed",
      last_error: reason,
      claimed_by: null,
      next_attempt_at: null,
    })
    .eq("id", row.id)
    .eq("status", row.status);
}

// Resumes run through a sequential chain — bounded concurrency (1) so a sweep
// that finds many stranded rows cannot stampede OpenAI/ffmpeg all at once.
let resumeChain: Promise<void> = Promise.resolve();

function chainedRunner(videoId: string, stage: Stage): void {
  resumeChain = resumeChain
    .then(() => runPipeline(videoId, stage))
    .catch((err: unknown) => {
      logger.error({ err, videoId }, "resumed pipeline run crashed");
    });
}

/**
 * One recovery pass: classify every job-relevant row and act on it. Used both
 * as the startup sweep and by the runtime watchdog. Every decision is logged.
 *
 * `opts.run` is injectable for tests (defaults to the bounded resume runner);
 * `opts.now` makes staleness deterministic in tests.
 */
export async function recoverJobs(
  opts: { now?: Date; run?: (videoId: string, stage: Stage) => void } = {},
): Promise<RecoveryDecision[]> {
  const now = opts.now ?? new Date();
  const run = opts.run ?? chainedRunner;
  const decisions: RecoveryDecision[] = [];

  const { data, error } = await supabase
    .from("videos")
    .select(
      "id, status, claimed_by, heartbeat_at, created_at, attempts, next_attempt_at, processing_stage, transcript, analysis",
    )
    .in("status", ["transcribing", "analyzing", "indexing", "retrying", "uploading", "uploaded"]);

  if (error) {
    logger.error({ err: error }, "recovery sweep query failed");
    return decisions;
  }

  for (const raw of (data ?? []) as unknown as JobRow[]) {
    const row = raw;
    const decision = await classifyAndAct(row, now, run);
    decisions.push(decision);
    if (decision.action !== "skip") {
      logger.info(
        {
          videoId: decision.videoId,
          status: decision.status,
          classification: decision.classification,
          action: decision.action,
          stage: decision.stage,
        },
        "recovery decision",
      );
    }
  }
  return decisions;
}

async function classifyAndAct(
  row: JobRow,
  now: Date,
  run: (videoId: string, stage: Stage) => void,
): Promise<RecoveryDecision> {
  const base = { videoId: row.id, status: row.status } as const;

  // --- Server-side in-flight stages -------------------------------------
  if (IN_FLIGHT_STATUSES.includes(row.status)) {
    const stage = row.status as Stage;
    const hbAge = row.heartbeat_at
      ? now.getTime() - new Date(row.heartbeat_at).getTime()
      : Number.POSITIVE_INFINITY;
    const ownedByUs = row.claimed_by === INSTANCE_ID;
    const stale = hbAge > STAGE_STALE_MS[stage];

    if (ownedByUs && !stale) {
      return { ...base, classification: "active", action: "skip", stage };
    }

    const classification = ownedByUs ? "stale" : "orphaned";
    const attempts = (row.attempts ?? 0) + 1;
    if (attempts > MAX_ATTEMPTS) {
      await markFailed(
        row,
        row.transcript
          ? `Processing was interrupted repeatedly during ${stage} and attempts are exhausted`
          : `Processing crashed during ${stage} and attempts are exhausted`,
      );
      return { ...base, classification: "exhausted", action: "fail", stage };
    }

    if (await reclaim(row, stage, now, attempts)) {
      run(row.id, stage);
      return { ...base, classification, action: "resume", stage };
    }
    return { ...base, classification: "claim-lost", action: "skip", stage };
  }

  // --- uploading: client-owned, unresumable server-side ------------------
  if (row.status === "uploading") {
    const startedAt = row.heartbeat_at ?? row.created_at;
    const age = startedAt
      ? now.getTime() - new Date(startedAt).getTime()
      : Number.POSITIVE_INFINITY;
    if (age > UPLOADING_TTL_MS) {
      await markFailed(row, "Upload never completed — please upload the file again");
      return { ...base, classification: "upload-expired", action: "fail" };
    }
    return { ...base, classification: "upload-in-progress", action: "skip" };
  }

  // --- uploaded: media confirmed but processing never started ------------
  if (row.status === "uploaded") {
    if (await reclaim(row, "transcribing", now)) {
      run(row.id, "transcribing");
      return {
        ...base,
        classification: "uploaded-never-started",
        action: "resume",
        stage: "transcribing",
      };
    }
    return { ...base, classification: "claim-lost", action: "skip" };
  }

  // --- retrying: waiting for backoff to elapse ----------------------------
  if (row.status === "retrying") {
    const due = !row.next_attempt_at || new Date(row.next_attempt_at).getTime() <= now.getTime();
    if (!due) {
      return { ...base, classification: "retry-waiting", action: "skip" };
    }
    const stage = inferStage(row);
    if (await reclaim(row, stage, now)) {
      run(row.id, stage);
      return { ...base, classification: "retry-due", action: "resume", stage };
    }
    return { ...base, classification: "claim-lost", action: "skip", stage };
  }

  return { ...base, classification: "active", action: "skip" };
}

/**
 * Boot the job system: run the startup recovery sweep immediately, then keep a
 * lightweight watchdog running so a silent job death (or an elapsed retry
 * backoff) is picked up without needing a restart.
 */
export function startJobSystem(): { stop: () => void } {
  logger.info({ instanceId: INSTANCE_ID }, "job system starting — running startup recovery sweep");
  void recoverJobs()
    .then((decisions) => {
      const acted = decisions.filter((d) => d.action !== "skip");
      logger.info(
        { scanned: decisions.length, acted: acted.length },
        "startup recovery sweep complete",
      );
    })
    .catch((err: unknown) => {
      logger.error({ err }, "startup recovery sweep failed");
    });

  const timer = setInterval(() => {
    void recoverJobs().catch((err: unknown) => {
      logger.error({ err }, "watchdog recovery sweep failed");
    });
  }, WATCHDOG_INTERVAL_MS);
  timer.unref?.();

  return { stop: () => clearInterval(timer) };
}
