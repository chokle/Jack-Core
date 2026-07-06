---
name: Video preview vs processing success
description: A browser <video> playback error is a client-side preview limitation, not a pipeline failure — never conflate the two.
---

Jack's ingest pipeline (transcription/analysis) accepts a broader set of video containers than browsers can natively decode in a `<video>` element — e.g. `.mov`, `.avi`, `.mkv`, `.3gp` are all valid, processable sources (ffmpeg handles them fine for audio extraction), but Chrome/Firefox commonly refuse to play some codec/container combinations inside those files (QuickTime/HEVC, MKV, 3GP, AVI), throwing the browser's generic "No video with supported format and MIME type found" error.

**Why:** A user correctly interpreted that native browser error as "my upload failed," even though transcription/analysis had completed successfully. The failure is purely in the `<video>` element's decode capability, not in the pipeline.

**How to apply:**
- Never let a `<video>` `onError` event, or any other browser playback failure, mutate `video.status` or trigger a "failed" pipeline state. Processing status and preview playability are orthogonal.
- Detect playback errors client-side (`onError` on the `<video>` element) and swap the player area for a friendly explanation — keep the transcript/analysis panels fully visible and interactive regardless.
- Offer a way to get the original bytes back (e.g. a "Download original" link to the stored `video_url`) plus guidance to convert to MP4 (H.264/AAC) for future in-browser preview.
- Separately, make sure the Content-Type stored in Supabase Storage at upload time is accurate (some browsers send a generic mimetype like `application/octet-stream` for certain video files) — fall back to an extension-based lookup so the served Content-Type header doesn't itself break playback for files that *would* otherwise be supported (Safari especially is strict about this header matching the actual format).
