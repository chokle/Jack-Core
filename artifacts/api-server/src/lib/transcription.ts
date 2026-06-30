import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
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
}

/**
 * Whisper rejects uploads larger than 25 MB. We extract a compact speech-grade
 * audio track and, when that is still too large, split it into time-based chunks
 * that each stay safely under the limit.
 */
const SINGLE_PASS_MAX_BYTES = 24 * 1024 * 1024;
const CHUNK_TARGET_BYTES = 20 * 1024 * 1024;

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

async function transcribeFile(path: string): Promise<TranscriptionResult> {
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
 * transcript timeline is continuous. All temp files are removed before return.
 */
export async function transcribeFromUrl(videoUrl: string): Promise<TranscriptionResult> {
  const dir = await mkdtemp(join(tmpdir(), "jack-transcribe-"));
  try {
    const source = join(dir, "source");
    await downloadToFile(videoUrl, source);

    const audio = join(dir, "audio.m4a");
    await extractAudio(source, audio);
    const { size } = await stat(audio);

    if (size <= SINGLE_PASS_MAX_BYTES) {
      return await transcribeFile(audio);
    }

    const duration = await probeDurationSeconds(audio);
    const numChunks = Math.ceil(size / CHUNK_TARGET_BYTES);
    const chunkDuration = Math.ceil(duration / numChunks);
    logger.info(
      { audioBytes: size, duration, numChunks, chunkDuration },
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

    return { text: texts.join(" ").trim(), segments: allSegments };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
