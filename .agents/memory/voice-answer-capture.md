---
name: Voice answer capture
description: Durable browser + server rules for recording spoken input and transcribing it server-side (Whisper), learned building Interview Mode's voice-first answer flow.
---

# Voice capture → server-side transcription

## There is no browser speech-to-text here — record audio, transcribe on the server
The runtime has NO usable Web Speech `SpeechRecognition`. Capture audio in the
browser with `getUserMedia` + `MediaRecorder`, POST the Blob, and transcribe with
OpenAI Whisper on the server.
**Why:** relying on `SpeechRecognition` silently no-ops for most users.
**How to apply:** any "talk to it" / dictation feature = MediaRecorder client +
a server transcription endpoint; never assume in-browser STT.

## Feature-detect the recording MIME type — iOS Safari only does mp4
Never hardcode `audio/webm`. Probe with `MediaRecorder.isTypeSupported` over a
priority list (`audio/webm;codecs=opus` → `audio/webm` → `audio/ogg;codecs=opus`
→ `audio/mp4`) and fall back to the platform default in a constructor try/catch.
Chrome/Firefox emit webm/opus; **iOS Safari only supports `audio/mp4`**. Blobs
sometimes report `video/webm`/`video/mp4` even for audio-only streams, so the
server MIME allowlist + filename-extension mapper must accept those too (Whisper
detects format from the upload filename, so send the right extension).
**Why:** a hardcoded webm request throws on iOS and the feature is dead on mobile.

## getUserMedia can resolve AFTER unmount/cancel — guard or the mic leaks
The permission prompt is async. If the component unmounts (or the user cancels)
while the prompt is open, `start()` resumes after cleanup already ran, acquires
the stream, and leaves the mic live with no handle to release. Keep a
`mountedRef` (set false in the unmount cleanup) and an `abortStartRef` (set true
by `cancel()`); immediately after `await getUserMedia`, if either fired, stop the
stream's tracks and bail before creating the MediaRecorder.
**Why:** a live-but-orphaned mic is a privacy problem and shows the OS recording
indicator with no way to turn it off.

## Gate paid-AI upload endpoints BEFORE the body is buffered
A multipart endpoint that triggers paid AI work (Whisper transcription, etc.)
must run its auth/ownership/active-resource check as a SEPARATE middleware that
runs BEFORE multer, so a rejected caller never buffers the (up-to-cap) body or
spends a cent. Order: rate-limiter → async resource gate (404/409) → multer
(memoryStorage, size cap, MIME allowlist) → handler.
**Why:** gating inside the handler (after multer) still lets an anonymous caller
push the full capped payload and, worse, reach the paid model — a cost/DoS hole.
**How to apply:** this repo's precedent is `/videos/ingest` and
`/interview/sessions/:id/transcribe`; keep such multipart routes OUT of the
OpenAPI/Orval contract and call them with a manual `fetch(FormData)`.
