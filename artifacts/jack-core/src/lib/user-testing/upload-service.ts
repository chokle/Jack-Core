/**
 * Beta user-testing mode — recording upload with a local-download fallback.
 *
 * Framework-agnostic (no React) so it can be reused by any future testing
 * mode. A recording is NEVER discarded: if the upload endpoint is unreachable
 * or rejects the request, the blob is offered to the user as a local file
 * download and its metadata is remembered so the UI can prompt a retry later
 * in the same browser.
 *
 * Tester identity is intentionally NOT sent in this payload — the server
 * resolves it from the authenticated session (see threat_model.md: identity
 * must never be client-supplied). `testerId` here is kept only so the local
 * "pending upload" record is self-describing for the user.
 */

export interface TestRecordingMetadata {
  sessionId: string;
  timestamp: string;
  userAgent: string;
  screenResolution: string;
  durationMs: number;
  mimeType: string;
  appVersion?: string;
  testerId?: string;
}

export type UploadOutcome =
  | { status: "uploaded"; id: string }
  | { status: "saved-locally"; filename: string; reason: string };

const PENDING_KEY = "jack.userTesting.pendingRecordings";
const UPLOAD_ENDPOINT = "/api/testing/recordings";

function readPending(): TestRecordingMetadata[] {
  try {
    const raw = window.localStorage.getItem(PENDING_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TestRecordingMetadata[]) : [];
  } catch {
    return [];
  }
}

function writePending(list: TestRecordingMetadata[]): void {
  try {
    window.localStorage.setItem(PENDING_KEY, JSON.stringify(list));
  } catch {
    // Storage unavailable (private mode / quota) — the download fallback
    // still saves the recording locally, we just can't remember to retry it.
  }
}

export function listPendingRecordings(): TestRecordingMetadata[] {
  return readPending();
}

export function clearPendingRecording(sessionId: string): void {
  writePending(readPending().filter((m) => m.sessionId !== sessionId));
}

function persistPending(metadata: TestRecordingMetadata): void {
  writePending([...readPending().filter((m) => m.sessionId !== metadata.sessionId), metadata]);
}

function extensionFor(mimeType: string): string {
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("ogg")) return "ogv";
  return "webm";
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on a delay — some browsers need the click-to-download navigation
  // to actually start before the object URL is freed.
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * Upload one completed recording. Resolves — never rejects — so callers can
 * always react to a concrete outcome. On failure, the blob is downloaded to
 * the user's machine immediately and the metadata is queued for retry.
 */
export async function uploadTestRecording(
  blob: Blob,
  metadata: TestRecordingMetadata,
): Promise<UploadOutcome> {
  const filename = `jack-user-test-${metadata.sessionId}.${extensionFor(metadata.mimeType)}`;

  try {
    const form = new FormData();
    form.append("file", blob, filename);
    form.append("sessionId", metadata.sessionId);
    form.append("userAgent", metadata.userAgent);
    form.append("screenResolution", metadata.screenResolution);
    form.append("durationMs", String(metadata.durationMs));
    if (metadata.appVersion) form.append("appVersion", metadata.appVersion);

    const res = await fetch(UPLOAD_ENDPOINT, { method: "POST", body: form });
    if (!res.ok) throw new Error(`Upload failed with status ${res.status}`);

    const data = (await res.json()) as { id: string };
    clearPendingRecording(metadata.sessionId);
    return { status: "uploaded", id: data.id };
  } catch (err) {
    persistPending(metadata);
    downloadBlob(blob, filename);
    return {
      status: "saved-locally",
      filename,
      reason: err instanceof Error ? err.message : "Upload failed",
    };
  }
}
