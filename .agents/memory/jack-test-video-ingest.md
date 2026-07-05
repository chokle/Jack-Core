---
name: Creating a processable test video for Jack
description: The dev seed videos can't be processed (missing media); how to make one real completed video with segments/analysis/concepts to verify processing-dependent UI.
---

# Getting one real fully-processed video into Jack

The dev Supabase seed videos are NOT processable: one has no file at all, the other's `video_url` points to a `jack-videos` storage object that no longer exists. The pipeline fails at the download step ("Failed to download source (400/404)") and after `MAX_ATTEMPTS=3` goes terminal `failed`. So any "confirm/prove X after a video is processed" task starts with zero real transcript segments, analysis, or distilled concept nodes.

To get one real end-to-end processed video (Whisper → GPT-4o → embeddings → distillation) without hand-seeding malformed graph rows:

1. **OpenAI TTS** — `POST https://api.openai.com/v1/audio/speech` (model `tts-1`, a voice, a trade-relevant script) → mp3. `OPENAI_API_KEY` is a real key here; direct `api.openai.com` works.
2. **ffmpeg** — mux the mp3 over a solid color source into a small H.264/AAC mp4 (`-f lavfi -i color=... -i audio.mp3 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest`). ffmpeg/ffprobe are on PATH.
3. **Ingest** — admin login (`POST /api/admin/login`, body `{ "password": <JACK_ADMIN_KEY> }`) → cookie; then `POST /api/videos/ingest` multipart with fields `file`, `title`, `trade`, `description`. The server uploads to `jack-videos` and kicks off the pipeline; a ~50s clip reaches `completed` in well under a minute.

**Result contract (what processing-dependent UI reads):**
- `GET /api/videos/:id` → camelCase `transcript`, `analysis`, `keyPoints[]`, `competencyCodes[]`, and `segments[]{ id, startTime, endTime, text, confidence }`.
- `GET /api/graph` → a `video:<id>` node plus distilled concept nodes whose `meta.sources[].timestamps` fall inside real segment `[startTime,endTime]` ranges. That overlap is exactly what the graph popover's TranscriptContent uses (`t >= s.startTime && t <= s.endTime`) to render passages; the Play button calls `onJumpToTimestamp(videoId, startTime)`.

**Why:** several sibling tasks are "confirm behavior after a real video is processed," but the environment ships no processable media. This recipe unblocks them and produces correctly-shaped graph data instead of risky hand-seeded rows.
