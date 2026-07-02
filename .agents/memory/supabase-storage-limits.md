---
name: Supabase Storage upload limits & streaming
description: Project-level file-size cap rejects large uploads with 413; storage-js stream support
---

- The Supabase **project setting** "Upload file size limit" (Dashboard → Storage → Settings; free-tier default ~50 MB) rejects larger objects with a 413 `The object exceeded the maximum allowed size` — regardless of any app-side cap (Jack's UI advertises 2 GB). Raise the project setting before expecting large uploads to succeed.
- **Why:** a 280 MB streamed upload failed with 413 even though the app's multer cap is 2 GB; the limit is enforced server-side by Supabase per project.
- **How to apply:** any work on large video uploads must confirm the Supabase project limit ≥ the app cap, or surface the 413 as a friendly error.
- `@supabase/storage-js` ≥ 2.108 accepts a Node `fs.createReadStream` in `.upload()` and auto-sets `duplex: "half"` for undici — no manual fetch workaround needed for streaming uploads.
