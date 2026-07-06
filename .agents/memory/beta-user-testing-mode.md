---
name: Beta user-testing mode (screen+mic recording)
description: Design decisions behind the "Start User Test" / ?test=true screen+mic recording feature in jack-core — private storage, identity resolution, and modal-trigger wiring patterns worth reusing.
---

Jack Core has a self-contained beta user-testing mode (`artifacts/jack-core/src/lib/user-testing/*`, `artifacts/jack-core/src/components/testing/*`, backend `artifacts/api-server/src/routes/testing.ts`). A few decisions are non-obvious and worth reusing if similar features are added:

- **Sensitive media uploads go to a PRIVATE bucket, never a public URL.** `jack-test-recordings` (Supabase Storage) is `public: false`; the row stores only `storage_path`, never a public URL, because a screen recording can capture arbitrary on-screen content (unlike video-library uploads, which are meant to be public). Any future "capture what the user is doing" feature should follow this, not the public-video-upload pattern.
- **Server always resolves identity itself; never trust a client-supplied tester id.** The upload route calls `resolveIdentity(req)` (same helper as admin reviewer attribution) and ignores any identity-like field in the multipart body. The frontend's `testerId` field exists only for local pending-upload bookkeeping/display, and is deliberately never sent to the server.
- **Multipart upload route is intentionally outside the OpenAPI/Orval contract**, mirroring the existing `/videos/ingest` precedent — disk-spooled multer -> Supabase Storage using the service-role key, with rollback of the storage object if the DB insert fails.
- **Opening a modal owned by a sibling/ancestor component uses `forwardRef` + `useImperativeHandle` exposing `{ open() }`**, not a boolean prop threaded down — the trigger button lives in the app shell (`JackShell`) while the modal + recording state machine live in an overlay mounted once near the app root (`TestingOverlay`, mounted from `App.tsx`). `App.tsx` holds the ref and passes `onStartUserTest={() => ref.current?.open()}` down to the shell.
- **`useToast`'s `TOAST_LIMIT` is 1 in this app** (see `hooks/use-toast.tsx`) — a toast used for a long-lived on-screen reminder would evict any other toast. The 8-second "think out loud" reminder therefore renders as its own fixed-position component with a local `setTimeout`, not through `useToast`.
- A recording is never silently lost: on upload failure the blob is downloaded locally via an `<a download>` link and its metadata is persisted to `localStorage` for a later manual retry — never just discarded.
