import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { openai, MODELS } from "./openai.js";
import { logger } from "./logger.js";

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptionResult {
  text: string;
  segments: TranscriptSegment[];
  /** Source video duration in seconds, or null if it could not be probed. */
  durationSeconds: number | null;
  /** A scaled JPEG poster frame, or null if extraction failed. */
  thumbnailJpeg: Buffer | null;
}

/**
 * Whisper rejects uploads larger than 25 MB. We extract a compact speech-grade
 * audio track and, when that is still too large, split it into time-based chunks
 * that each stay safely under the limit.
 */
const SINGLE_PASS_MAX_BYTES = 24 * 1024 * 1024;
const CHUNK_TARGET_BYTES = 20 * 1024 * 1024;

/**
 * Hard cap on source video file size. Requests to transcribe videos larger than
 * this are rejected before any download, ffmpeg, or OpenAI work is started.
 * 500 MB is a generous upper bound for training clips; it keeps per-request
 * bandwidth, CPU, and OpenAI spend bounded for anonymous callers.
 */
export const MAX_SOURCE_VIDEO_BYTES = 500 * 1024 * 1024;

/**
 * Maximum number of Whisper API calls allowed per transcription job. Caps the
 * OpenAI cost for a single (possibly very long) video regardless of its size.
 */
const MAX_WHISPER_CHUNKS = 10;

/**
 * Mono, 16 kHz, low-bitrate AAC — plenty for speech recognition and an order of
 * magnitude smaller than the source video. AAC uses ffmpeg's built-in encoder,
 * so it works with any ffmpeg build (no external codec libraries required).
 */
const AUDIO_ARGS = ["-vn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "64k"];

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

/**
 * Check the declared Content-Length of a URL via HEAD request and throw if it
 * exceeds the configured limit. Prevents downloading large files before we know
 * they are within the workload budget. Servers that omit Content-Length are not
 * blocked here — they are bounded by the disk quota at download time.
 */
async function assertSourceSize(url: string, maxBytes: number): Promise<void> {
  const head = await fetch(url, { method: "HEAD" });
  const contentLength = head.headers.get("content-length");
  if (contentLength !== null) {
    const bytes = parseInt(contentLength, 10);
    if (Number.isFinite(bytes) && bytes > maxBytes) {
      throw new Error(
        `Source video is too large: ${bytes} bytes exceeds the ${maxBytes}-byte limit`,
      );
    }
  }
}

async function downloadToFile(url: string, dest: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download source (${response.status} ${response.statusText})`);
  }
  await pipeline(
    Readable.fromWeb(response.body as NodeWebReadableStream<Uint8Array>),
    createWriteStream(dest),
  );
}

async function extractAudio(input: string, output: string): Promise<void> {
  await run("ffmpeg", ["-nostdin", "-y", "-i", input, ...AUDIO_ARGS, output]);
}

async function extractAudioChunk(
  input: string,
  output: string,
  start: number,
  duration: number,
): Promise<void> {
  // `-ss`/`-t` before `-i` enables fast, accurate seeking for a re-encoded slice.
  await run("ffmpeg", [
    "-nostdin",
    "-y",
    "-ss",
    start.toString(),
    "-t",
    duration.toString(),
    "-i",
    input,
    ...AUDIO_ARGS,
    output,
  ]);
}

async function probeDurationSeconds(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      file,
    ]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      const seconds = Number.parseFloat(stdout.trim());
      if (code === 0 && Number.isFinite(seconds) && seconds > 0) resolve(seconds);
      else reject(new Error(`ffprobe could not read duration: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

/**
 * Best-effort duration probe. Returns null instead of throwing so a probe
 * failure never fails the transcription job — duration is enrichment only.
 */
async function probeDurationSafe(file: string): Promise<number | null> {
  try {
    return await probeDurationSeconds(file);
  } catch (err) {
    logger.warn({ err }, "transcribe: duration probe failed — continuing");
    return null;
  }
}

/**
 * Best-effort poster-frame extraction. Seeks 1s in for a representative frame
 * (skips a black lead-in) and falls back to the very first frame for short
 * clips. Scales to 640px wide (even height) at moderate quality. Returns null
 * instead of throwing — a thumbnail is enrichment and must never fail the job.
 */
async function extractThumbnailSafe(input: string, output: string): Promise<Buffer | null> {
  for (const seek of ["1", "0"]) {
    try {
      await run("ffmpeg", [
        "-nostdin",
        "-y",
        "-ss",
        seek,
        "-i",
        input,
        "-frames:v",
        "1",
        "-vf",
        "scale=640:-2",
        "-q:v",
        "3",
        output,
      ]);
      const buf = await readFile(output);
      if (buf.length > 0) return buf;
    } catch (err) {
      logger.warn({ err, seek }, "transcribe: thumbnail extraction attempt failed");
    }
  }
  return null;
}

async function transcribeFile(
  path: string,
): Promise<{ text: string; segments: TranscriptSegment[] }> {
  const transcription = await openai.audio.transcriptions.create({
    file: createReadStream(path),
    model: MODELS.transcription,
    response_format: "verbose_json",
    timestamp_granularities: ["segment"],
  });
  const segments = (transcription.segments ?? []).map((s) => ({
    start: s.start,
    end: s.end,
    text: s.text.trim(),
  }));
  return { text: transcription.text, segments };
}

/**
 * Download a video, extract speech audio, and transcribe it with Whisper,
 * chunking automatically when the audio exceeds Whisper's upload limit. Segment
 * timestamps from every chunk are offset by the chunk's start time so the final
 * transcript timeline is continuous. Also extracts a poster-frame thumbnail and
 * the source duration (both best-effort — never fatal). All temp files are
 * removed before return.
 */
export async function transcribeFromUrl(videoUrl: string): Promise<TranscriptionResult> {
  // Reject oversized sources before any download or ffmpeg work starts.
  await assertSourceSize(videoUrl, MAX_SOURCE_VIDEO_BYTES);

  const dir = await mkdtemp(join(tmpdir(), "jack-transcribe-"));
  try {
    const source = join(dir, "source");
    await downloadToFile(videoUrl, source);

    // Enrichment (best-effort, never fatal): probe the source duration and grab
    // a poster frame from the original video while the temp file still exists.
    const durationSeconds = await probeDurationSafe(source);
    const thumbnailJpeg = await extractThumbnailSafe(source, join(dir, "thumb.jpg"));

    const audio = join(dir, "audio.m4a");
    await extractAudio(source, audio);
    const { size } = await stat(audio);

    if (size <= SINGLE_PASS_MAX_BYTES) {
      const { text, segments } = await transcribeFile(audio);
      return { text, segments, durationSeconds, thumbnailJpeg };
    }

    const duration = await probeDurationSeconds(audio);
    const rawChunks = Math.ceil(size / CHUNK_TARGET_BYTES);
    const numChunks = Math.min(rawChunks, MAX_WHISPER_CHUNKS);
    const chunkDuration = Math.ceil(duration / numChunks);
    logger.info(
      { audioBytes: size, duration, numChunks, rawChunks, chunkDuration },
      "transcribe: chunking large audio",
    );

    const texts: string[] = [];
    const allSegments: TranscriptSegment[] = [];

    for (let i = 0; i < numChunks; i++) {
      const start = i * chunkDuration;
      if (start >= duration) break;
      const slice = Math.min(chunkDuration, duration - start);
      const chunkPath = join(dir, `chunk-${i}.m4a`);
      await extractAudioChunk(audio, chunkPath, start, slice);

      const part = await transcribeFile(chunkPath);
      const trimmed = part.text.trim();
      if (trimmed) texts.push(trimmed);
      for (const seg of part.segments) {
        allSegments.push({ start: seg.start + start, end: seg.end + start, text: seg.text });
      }
      await rm(chunkPath, { force: true });
    }

    return {
      text: texts.join(" ").trim(),
      segments: allSegments,
      durationSeconds,
      thumbnailJpeg,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
