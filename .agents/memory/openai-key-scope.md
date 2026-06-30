---
name: OpenAI key audio scope
description: Whisper transcription 401s here because the project OpenAI key lacks the audio scope.
---

The project `OPENAI_API_KEY` is a restricted key that does NOT include the
`api.model.audio.request` scope. Any call to `openai.audio.transcriptions`
(whisper-1) returns HTTP 401 "insufficient permissions ... Missing scopes:
api.model.audio.request" — the request is rejected on auth before the audio is
ever validated.

**Why:** Confirmed via a direct multipart call to `/v1/audio/transcriptions`.
Chat + embeddings calls with the same key work; only audio is blocked. This
affects transcription regardless of code — the old single-pass path and the new
extract/chunk path fail identically.

**How to apply:** If transcribe jobs flip a video to `status='error'` with a
401, it's the key scope, not the pipeline. Fix by granting the key audio
permissions (or supplying a key with `model.audio` scope) in the OpenAI
dashboard. Do NOT debug the ffmpeg/extraction/upload code for this symptom.
