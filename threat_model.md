# Threat Model

## Project Overview

Jack is a React + Vite single-page application backed by an Express 5 API and Supabase (PostgreSQL, pgvector, and Supabase Storage). It ingests training videos, stores transcripts and chat history, performs OpenAI-backed transcription/analysis, and serves a searchable knowledge library with chat answers and timestamp citations.

Production security review should focus on `artifacts/api-server/` and the SPA in `artifacts/jack-core/`. Per project guidance, `artifacts/mockup-sandbox/` is dev-only and out of scope unless production reachability is demonstrated. `scripts/` is operational tooling, not a production request path.

## Assets

- **Video library contents** — uploaded videos, transcripts, analyses, competency mappings, and semantic embeddings. Unauthorized modification or deletion would corrupt the knowledge base.
- **User-submitted chat content** — user questions, assistant responses, citations, and session identifiers. This data may contain proprietary training questions or operational details and should not leak across users.
- **Application secrets and privileged service credentials** — the Supabase service-role key and OpenAI API key. The API uses the service-role key, so any server-side access control failure exposes broad database and storage privileges.
- **Paid compute and storage resources** — OpenAI transcription/analysis spend, Supabase storage, and server CPU/bandwidth used for media download/transcode. Public abuse can translate directly into cost and service degradation.

## Trust Boundaries

- **Browser to Express API** — all client requests cross from an untrusted browser into the server. Every mutating or sensitive endpoint must enforce authorization and abuse controls server-side.
- **Express API to Supabase** — the API talks to Supabase using a service-role key that bypasses row-level restrictions. Bugs in route-layer authorization therefore become full read/write data exposure.
- **Express API to Supabase Storage** — the API issues signed upload URLs and writes public object URLs back into the database. Upload path ownership and file acceptance rules must be enforced here.
- **Express API to OpenAI** — chat, embeddings, transcription, and analysis calls consume paid third-party APIs. Public triggering without quotas or authorization creates direct cost and denial-of-service risk.
- **Public versus restricted functionality** — the current code exposes library browsing, chat, video ingestion, mutation, deletion, upload URL issuance, transcription, and analysis from the same public API surface; there is no authenticated or admin-only boundary in code.
- **Internal/dev-only versus production** — `artifacts/mockup-sandbox/` and `scripts/` should normally be ignored for production findings unless separately deployed or invoked by production code.

## Scan Anchors

- Production API entry points: `artifacts/api-server/src/app.ts`, `artifacts/api-server/src/routes/*.ts`
- Highest-risk server code: `artifacts/api-server/src/routes/videos.ts`, `artifacts/api-server/src/routes/chat.ts`, `artifacts/api-server/src/lib/supabase.ts`, `artifacts/api-server/src/lib/transcription.ts`
- Highest-risk client code: `artifacts/jack-core/src/components/AskJack.tsx`, `artifacts/jack-core/src/components/VideoDetail.tsx`, upload/chat flows in `artifacts/jack-core/src/components/UploadModal.tsx`
- Public surfaces: all `/api/*` routes are currently public; there is no server-enforced authenticated/admin surface
- Dev-only areas to usually skip: `artifacts/mockup-sandbox/`, `scripts/`

## Threat Categories

### Tampering

The application allows creation, mutation, deletion, upload orchestration, transcription, and analysis of shared video records through public API routes. Because the server uses the Supabase service-role key, the route layer must be the enforcement point for ownership and privilege checks. Required guarantee: only authorized actors may create signed upload URLs, modify video metadata/state, delete records, or trigger processing jobs for shared assets.

### Information Disclosure

The system stores transcripts, chat prompts, assistant responses, citations, and session identifiers in Supabase, then returns them to the SPA. Cross-session leakage is especially relevant because chat history is persisted centrally and the frontend renders server-returned content directly. Required guarantee: chat history and other user-generated content must be scoped to the originating user/session and any HTML-capable rendering path must treat stored content as untrusted.

### Denial of Service

Video ingestion downloads large media files, runs ffmpeg/ffprobe, and calls OpenAI transcription, embedding, and chat models. Search and chat endpoints also invoke paid embeddings/completions. Required guarantee: public requesters must not be able to trigger unbounded storage growth, expensive AI jobs, or repeated large-media processing without authentication, ownership checks, size limits, and rate limiting.

### Elevation of Privilege

Because there is no separate authenticated or admin surface in code, any public caller currently reaches routes that exercise the Supabase service role and signed upload URL issuance. Required guarantee: a low-privilege or anonymous caller must never be able to obtain service-role-equivalent effects such as broad database mutation, storage write access, or access to other users' conversations by supplying identifiers or crafted content.

### Spoofing

Chat sessions are keyed by caller-supplied or server-generated session IDs, and the backend uses those IDs to load prior conversation state. Required guarantee: session identifiers must not be sufficient by themselves to read or continue another user's conversation, and public endpoints must not leak identifiers that let callers impersonate another conversation context.
