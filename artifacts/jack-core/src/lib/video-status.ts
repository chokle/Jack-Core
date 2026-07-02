/**
 * Video processing lifecycle:
 *   queued → uploading → uploaded → transcribing → analyzing → indexing → completed
 * plus `failed` (terminal, lastError set) and `retrying` (waiting for an
 * automatic re-attempt). Anything in this set means "still working" — the UI
 * polls faster while any of these are present.
 */
export const IN_FLIGHT_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "uploading",
  "uploaded",
  "transcribing",
  "analyzing",
  "indexing",
  "retrying",
]);
