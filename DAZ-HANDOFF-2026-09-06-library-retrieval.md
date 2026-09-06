# Library context and retrieval repair

## Approved video explanation plan — current implementation

Status: implementation and focused checks complete; final review, CI, release, and live acceptance pending. Older uploader-only disposition below is superseded by Derek's explicit "Match Library access" decision and subsequent "Implement the proposed plan" dispatch.

- Sole integration owner: Dex task `01a06ffb-7a31-7ff1-92ea-fddf07a3a308`; original owner transferred clean PR144 head `4eb6af35f0f70e2edc2ad518a0640d9554437873` and stopped writes. Existing isolated checkout retained; root dirty checkout and PR145 untouched.
- Read policy: the same authenticated shared Library reads used by the Library now resolve Jack's named/selected videos. Client IDs and titles do not authorize reads. Existing uploader checks on mutations remain intact; no schema or sharing grants were changed.
- Named videos and selected videos now share saved-analysis, key-points, transcript retrieval and rejection filtering. Missing explicitly named titles do not silently select another video. Ambiguous visible cards ask which title; general questions do not inherit a video accidentally.
- Transcript pages include later recording content; overview samples span the recording, specific questions rank relevant passages, and timestamp questions select the actual interval. Reads are bounded at 20,000 rows with explicit degraded state. Review lookup errors fail closed for this path.
- Retrieved source text is a separate untrusted data message, not system authority. The actual user question remains last. Jack's prompt requires practical video explanations from saved evidence and forbids describing UI metadata as the requested content.
- Both chat interfaces invalidate late answers/citations on page/video/tab changes. Analysis-only sources open the video without a fabricated timestamp; timed clips retain actual seeking.
- Focused verification: 97 backend tests across 6 files; 37 frontend tests across 3 files. Fixtures/stubbed generation prove data flow and UI behavior, not real production/model/Pixel acceptance.
- Real authenticated E-3 and 3gdemo explanations, citation seeking, repeated cloned audio, and Pixel acceptance remain unverified. No accessible authenticated browser/device connection was found; Derek was asked about availability for after-deployment testing. No completion claim is authorized by these local results.
- Release coordination belongs to mission task `01a078e5-5250-7d00-9f5e-f2884f604542`; serialize main integration and production deployment with PR147. Rollback is the preceding production main commit through the existing exact Cloudflare workflow.

## Historical receipts (superseded where noted above)

## Mission review update (2026-09-06)

- Reviewed implementation: `27d17a51bd62e5764e0a6acb579d68dd6439c3ed`.
- Direct transcript lookup now applies existing reviewer verification rules even when vector search returns no matches. Rejected windows are excluded, and untimed transcript/analysis/key-point/description fallbacks are suppressed when they could reintroduce rejected material. Citation trust metadata is retained.
- Media context is used for media questions and bare contextual requests. General questions and "this button" do not trigger Library access failures. Explicitly named other videos retain title lookup; quoted technical terms still use the selected video.
- Independent read-only review cleared these changes. CodeRabbit's green draft status is not a completed review; Aikido was skipped for the draft.
- Latest focused run: 3 files / 16 tests PASS, 118.82 seconds wall time (238ms test execution). An earlier run recorded 15 passes and one 5-second timeout during severe shared-machine contention; the successful rerun supersedes that failure without hiding it.
- Exact-code-head CI: https://github.com/chokle/Jack-Core/actions/runs/34065883543 completed SUCCESS at 2026-09-06 23:07:52 UTC. Actual full API tests (65 files / 865 tests), full frontend tests (53 files / 477 tests), workspace typecheck, workspace build, container smoke, and diff-check steps passed. Semgrep passed. Existing bundle-size and tooltip sourcemap warnings remained nonfatal.
- Local simulated browser fixture: first navigation timed out after 30 seconds; a bounded retry produced no acceptance evidence and was cancelled. Vite and browser runner sessions were stopped and the local heavy-job slot released to the coordinator. No browser, production, video playback, or physical audio PASS is claimed.
- Current disposition: DRAFT / RELEASE HOLD. Next actor is coordinator/Daz for access-policy reconciliation and legitimate authenticated real-asset/Pixel acceptance. No merge or deployment occurred in this task.

- Repository: `chokle/Jack-Core`
- Isolated checkout: `D:/Code/worktrees/Jack-library-retrieval-20260906`
- Branch: `codex/fix-library-retrieval-20260906`
- Base: `99cf82ae92bf59ed6382b49d230a664a2ec29d44`
- Implementation commit: `9279b53c3d6377c3a02d152a9015d5fdbff6f5fb`
- PR: https://github.com/chokle/Jack-Core/pull/144 (draft).
- Handoff delivery: committed repository artifact attached to PR #144; current remediation receipts delivered to the mission coordinator through Codex task messages.

## Verified cause and data path

`jobs.ts` saves transcripts/segments, analysis and key points, then embeds transcript segments and the whole video. `match_transcript_segments` is the existing semantic retrieval RPC. The screenshot's indexed/completed labels alone do not prove the specific production rows or embeddings exist.

Before: VideoCard had an ID/title in the DOM, but the UI packet carried only untyped visible IDs. `/chat` embedded only the question and its secondary direct-video path required an explicitly named/quoted title. Current UI resource IDs never selected the saved media. The floating pill also discarded the API's citations.

After: both chat interfaces use the same bounded resource packet (ID, title, trade, processing status, selected versus visible). The backend validates the packet and uses the server-authenticated user plus exact video IDs to resolve saved video content. Up to six relevant timestamped transcript segments from a bounded 1,000-segment read supplement the existing semantic retrieval; active-video context is used for contextual media questions while explicit video titles retain named-title lookup. Metadata used for evidence comes from the database, not the client's title. Missing content returns an explicit failure without calling the model. Multiple visible cards do not silently become one selected asset.

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

1. Existing Library list/detail handlers perform broad authenticated reads; that implementation alone does not establish intended sharing authorization. The schema and audited documentation did not provide a positive shared-library grant. The new direct-ID path conservatively requires `uploader_user_id = req.userId`. Another uploader's media and unowned legacy rows are not retrieved by this new path. This preserves a conservative boundary, not a newly selected founder policy. Preserve it until existing permission evidence or a policy decision resolves the mismatch. Existing broad reads are outside this patch and are not certified as tenant-isolated.
2. Local route tests use FakeSupabase and a stubbed model. They prove structured context, indexed-record loading, source metadata, failure behavior, and ownership filtering; they do not prove production retrieval, real model no-repeat behavior, or physical audio.
3. Authenticated real-asset acceptance is still required: use the legitimate uploader account, open/select E-3, ask what the video shows and a question answered in a later segment, open its timestamp source, repeat in normal Ask Jack, then confirm actual voice output on the Pixel. No usable authenticated production session was available in this task. No new code was deployed.
4. Daz/reviewer: inspect the draft PR and resolve the access-model choice, then sequence an authorized release and record exact-head authenticated acceptance. Keep #112 acceptance open; this is not a completion claim for #112, telemetry, or #126.
5. The separately discussed persistent voice-pill layering change remains outside this Library patch.
