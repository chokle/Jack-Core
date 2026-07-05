/**
 * Client helper for the voice-answer transcription endpoint.
 *
 * Mirrors the multipart upload precedent in UploadModal (`/api/videos/ingest`):
 * a manual fetch with FormData and `credentials: "include"`, deliberately
 * OUTSIDE the OpenAPI/Orval contract (multipart is awkward to generate for one
 * tiny endpoint). The audio is transcribed server-side with Whisper and never
 * persisted — only the final edited text is submitted via the answers endpoint.
 */

/** Whisper detects the format from the filename, so send the right extension. */
const EXTENSION_BY_MIME: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "video/webm": "webm",
  "video/mp4": "mp4",
};

function extensionFor(mimeType: string): string {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  return EXTENSION_BY_MIME[base] ?? "webm";
}

export async function transcribeInterviewAnswer(
  sessionId: string,
  blob: Blob,
  mimeType: string,
): Promise<string> {
  const form = new FormData();
  form.append("audio", blob, `answer.${extensionFor(mimeType)}`);

  const res = await fetch(`/api/interview/sessions/${sessionId}/transcribe`, {
    method: "POST",
    credentials: "include",
    body: form,
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Transcription failed (${res.status})`);
  }

  const data = (await res.json().catch(() => ({}))) as { transcript?: unknown };
  if (typeof data.transcript !== "string") {
    throw new Error("Transcription failed — unexpected response from the server.");
  }
  return data.transcript;
}
