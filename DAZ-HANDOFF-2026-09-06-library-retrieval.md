# Library context and retrieval repair

Status: implementation committed; live acceptance NOT COMPLETE. No merge or deployment performed.

- Repository: `chokle/Jack-Core`
- Isolated checkout: `D:/Code/worktrees/Jack-library-retrieval-20260906`
- Branch: `codex/fix-library-retrieval-20260906`
- Base: `99cf82ae92bf59ed6382b49d230a664a2ec29d44`
- Implementation commit: `9279b53c3d6377c3a02d152a9015d5fdbff6f5fb`
- PR: https://github.com/chokle/Jack-Core/pull/144 (draft).
- Handoff delivery: committed repository artifact attached to PR #144; no message sent to another task or person.

## Verified cause and data path

`jobs.ts` saves transcripts/segments, analysis and key points, then embeds transcript segments and the whole video. `match_transcript_segments` is the existing semantic retrieval RPC. The screenshot's indexed/completed labels alone do not prove the specific production rows or embeddings exist.

Before: VideoCard had an ID/title in the DOM, but the UI packet carried only untyped visible IDs. `/chat` embedded only the question and its secondary direct-video path required an explicitly named/quoted title. Current UI resource IDs never selected the saved media. The floating pill also discarded the API's citations.

After: both chat interfaces use the same bounded resource packet (ID, title, trade, processing status, selected versus visible). The backend validates the packet and uses the server-authenticated user plus exact video IDs to resolve saved video content. Up to six relevant timestamped transcript segments from a bounded 1,000-segment read supplement the existing semantic retrieval; active-video context takes precedence over named-title fallback. Metadata used for evidence comes from the database, not the client's title. Missing content returns an explicit failure without calling the model. Multiple visible cards do not silently become one selected asset.

The floating pill renders returned video source buttons; the app routes a clicked source through existing video navigation and timestamp seek behavior. No arbitrary model-authored URL or DOM selector is executed.

## Files

- `artifacts/api-server/src/lib/library-context.ts`: direct resource lookup, ownership filter, transcript selection, explicit failure.
- `artifacts/api-server/src/lib/jack-ui-request-context.ts`: bounded optional resource validation and untrusted context serialization.
- `artifacts/api-server/src/routes/chat.ts`: integrates active content into the existing Ask Jack route after the authority gate.
- `artifacts/jack-core/src/lib/jack-ui-context.ts`: selected/viewport-visible metadata collection and header budget.
- `artifacts/jack-core/src/components/VideoCard.tsx`, `VideoDetail.tsx`: resource metadata attributes.
- `artifacts/jack-core/src/components/FloatingJack.tsx`, `artifacts/jack-core/src/App.tsx`: resource freshness comparison and timestamp source navigation.
- Six test files cover the backend context parser/loader/HTTP route and frontend collector/both chat interfaces.

## Verification

- Focused API/privacy/scoped-knowledge run: 5 files, 46 tests PASS.
- Focused frontend, including both chat interfaces and existing acceptance fixtures: 4 files, 52 tests PASS.
- Full API: 65 files, 860 tests PASS (`node node_modules/vitest/vitest.mjs run --maxWorkers=1` from API package).
- Full frontend: 53 files, 477 tests PASS (`node node_modules/vitest/vitest.mjs run --maxWorkers=1` from frontend package).
- `pnpm run typecheck`: PASS for workspace libraries, API, frontend, mockup sandbox, scripts.
- API `node build.mjs`: PASS.
- Frontend `node node_modules/vite/bin/vite.js build`: PASS; bundle-size and tooltip sourcemap warnings only.
- Prettier check for all changed TS/TSX files and `git diff --check`: PASS.
- Manual source/diff inspection: completed. No identity/persona prompt edits, migrations, dependency manifest changes, or deployment configuration changes.
- Windows runtime: exact esbuild 0.27.3 executable supplied per command via `ESBUILD_BINARY_PATH` from ignored `.local/esbuild/package/esbuild.exe`. Recovered an incomplete local es-object-atoms 1.1.2 installation from its published package. No dependency version changes.

## Limits and next actor

1. The existing Library reads are shared among authenticated users; video rows have uploader identity but no explicit organization-sharing grant. The new direct-ID path conservatively requires `uploader_user_id = req.userId`. Another uploader's media and unowned legacy rows are not retrieved by this new path. An optional user question about uploader-only versus existing shared-library access is pending. Preserve uploader-only until that decision is resolved; do not invent tenant membership from a UI ID. Existing broad Library read policy is outside this patch and is not certified as tenant-isolated.
2. Local route tests use FakeSupabase and a stubbed model. They prove structured context, indexed-record loading, source metadata, failure behavior, and ownership filtering; they do not prove production retrieval, real model no-repeat behavior, or physical audio.
3. Authenticated real-asset acceptance is still required: use the legitimate uploader account, open/select E-3, ask what the video shows and a question answered in a later segment, open its timestamp source, repeat in normal Ask Jack, then confirm actual voice output on the Pixel. No usable authenticated production session was available in this task. No new code was deployed.
4. Daz/reviewer: inspect the draft PR and resolve the access-model choice, then sequence an authorized release and record exact-head authenticated acceptance. Keep #112 acceptance open; this is not a completion claim for #112, telemetry, or #126.
5. The separately discussed persistent voice-pill layering change remains outside this Library patch.
