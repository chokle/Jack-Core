/**
 * Beta user-testing mode — recording upload with a local-download fallback.
 *
 * Framework-agnostic (no React) so it can be reused by any future testing
 * mode. A recording is NEVER discarded after an ordinary upload failure: the
 * blob is offered to the user as a local file download and its metadata is
 * remembered so the UI can prompt a retry later in the same browser.
 *
 * Tester identity is intentionally NOT sent in this payload — the server
 * resolves it from the authenticated session (see threat_model.md: identity
 * must never be client-supplied). `identityKey` only scopes browser-local
 * pending metadata so one signed-in user cannot see another user's record.
 */

export interface TestRecordingMetadata {
  sessionId: string;
  timestamp: string;
  durationMs: number;
  mimeType: string;
  microphoneIncluded: boolean;
  appVersion?: string;
  identityKey?: string;
}

export type UploadOutcome =
  | { status: "uploaded"; id: string }
  | { status: "saved-locally"; filename: string; reason: string }
  | { status: "cancelled" };

export interface UploadTestRecordingOptions {
  signal?: AbortSignal;
  /**
   * Rechecked immediately before any local persistence or download. Callers
   * use this to fail closed when the authenticated identity has changed.
   */
  shouldFallback?: () => boolean;
}

const PENDING_KEY = "jack.userTesting.pendingRecordings";
const UPLOAD_ENDPOINT = "/api/testing/recordings";

function pendingKey(identityKey?: string): string {
  const normalizedIdentity = identityKey?.trim();
  return normalizedIdentity ? `${PENDING_KEY}:${normalizedIdentity}` : PENDING_KEY;
}

function readPending(identityKey?: string): TestRecordingMetadata[] {
  try {
    const raw = window.localStorage.getItem(pendingKey(identityKey));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TestRecordingMetadata[]) : [];
  } catch {
    return [];
  }
}

function writePending(list: TestRecordingMetadata[], identityKey?: string): void {
  try {
    window.localStorage.setItem(pendingKey(identityKey), JSON.stringify(list));
  } catch {
    // Storage unavailable (private mode / quota) — the download fallback
    // still saves the recording locally, we just can't remember to retry it.
  }
}

export function listPendingRecordings(identityKey?: string): TestRecordingMetadata[] {
  return readPending(identityKey);
}

export function clearPendingRecording(sessionId: string, identityKey?: string): void {
  writePending(
    readPending(identityKey).filter((metadata) => metadata.sessionId !== sessionId),
    identityKey,
  );
}

function persistPending(metadata: TestRecordingMetadata): void {
  const identityKey = metadata.identityKey;
  writePending(
    [
      ...readPending(identityKey).filter(
        (pendingMetadata) => pendingMetadata.sessionId !== metadata.sessionId,
      ),
      metadata,
    ],
    identityKey,
  );
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

function isCancelled(options: UploadTestRecordingOptions): boolean {
  if (options.signal?.aborted) return true;
  if (!options.shouldFallback) return false;

  try {
    return options.shouldFallback() === false;
  } catch {
    // A failed ownership check must never expose a recording through fallback.
    return true;
  }
}

/**
 * Upload one completed recording. Resolves — never rejects — so callers can
 * always react to a concrete outcome. On an ordinary failure, the blob is
 * downloaded and metadata is queued for this identity. Cancellation or stale
 * identity returns without persisting or downloading anything.
 */
export async function uploadTestRecording(
  blob: Blob,
  metadata: TestRecordingMetadata,
  options: UploadTestRecordingOptions = {},
): Promise<UploadOutcome> {
  const filename = `jack-user-test-${metadata.sessionId}.${extensionFor(metadata.mimeType)}`;

  if (isCancelled(options)) {
    return { status: "cancelled" };
  }

  try {
    const form = new FormData();
    form.append("file", blob, filename);
    form.append("sessionId", metadata.sessionId);
    form.append("durationMs", String(metadata.durationMs));
    form.append("microphoneIncluded", String(metadata.microphoneIncluded));
    if (metadata.appVersion) form.append("appVersion", metadata.appVersion);

    const res = await fetch(UPLOAD_ENDPOINT, {
      method: "POST",
      body: form,
      signal: options.signal,
    });
    if (!res.ok) throw new Error(`Upload failed with status ${res.status}`);

    const data = (await res.json()) as { id: string };
    clearPendingRecording(metadata.sessionId, metadata.identityKey);
    if (isCancelled(options)) {
      return { status: "cancelled" };
    }
    return { status: "uploaded", id: data.id };
  } catch (err) {
    if (isCancelled(options)) {
      return { status: "cancelled" };
    }

    persistPending(metadata);
    downloadBlob(blob, filename);
    return {
      status: "saved-locally",
      filename,
      reason: err instanceof Error ? err.message : "Upload failed",
    };
  }
}
