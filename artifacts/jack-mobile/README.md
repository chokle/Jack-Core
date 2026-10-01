# Jack native Android field client

Issue [#209](https://github.com/chokle/Jack-Core/issues/209) controls this migration. This is an actual React Native / Expo SDK 55 client built from native views, inputs and media controls. Jack Core continues to own intelligence, provenance, authority and membership; no WebView or duplicated retrieval is used.

The first slice contains existing-account email-code sign-in, protected membership verification, a persistent Ask composer, Radio Jack, cited answers, authorized knowledge-source detail and authenticated source video at the citation timestamp. Settings exposes account and Android permissions. Dashboard/Radar, Living Memory navigation, Library management and Interview remain later migration steps and have no placeholder tabs in this slice.

## Development

This package has an isolated pnpm workspace/lock so Expo's React Native peer dependencies cannot change the production web client's React dependency graph. Run commands **inside this directory**, using Node 24 and the pinned pnpm version.

```powershell
pnpm install --frozen-lockfile
# Set these public build-time values using the existing Jack Clerk instance.
$env:EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY = '<existing Clerk publishable key>'
$env:EXPO_PUBLIC_JACK_API_URL = 'https://jack.torchlabs.ca'
pnpm typecheck
pnpm test
pnpm export:android
pnpm android
```

The key is a Clerk public key, never an API secret or user token. Missing configuration produces an explicit setup screen. Sign-in uses the existing Clerk instance and email OTP. No alternate identity or auth bypass exists. Accounts requiring unsupported MFA are directed to the administrator rather than bypassed. A successful Clerk session still needs the real `/api/chat/history` pilot/membership gate before Ask/Radio becomes available.

`export:android` verifies the production JS/native-module bundle. It is **not an APK build or device acceptance**. `prebuild:android` generates an Android project; `android` requires JDK/Android SDK and a device or emulator. The parent release workflow builds a standalone APK on a hosted Android runner; signing/store publication must follow the documented release gate.

## Runtime and API boundaries

Every request obtains the current Clerk bearer token. `/api/chat` returns the shared generated `ChatResponse`/`Citation` types, imported as types only; web React-query code is never bundled. Canonical `X-Jack-Context` describes the actual Ask/Source/Settings screen, selected source and native back navigation, with a new capture time on each request. It contains no unrelated app, GPS or device surveillance.

- `POST /api/chat`: existing shared intelligence and citations.
- `POST /api/jack/transcribe`: bounded multipart `audio`, returns `{text}`; audio is transient rather than organizational knowledge.
- `POST /api/jack/speech`: canonical Jack `audio/mpeg`; unavailable voice remains an explicit error beside the readable answer. No alternate device voice is substituted.
- `GET /api/jack/sources/video|knowledge/:id`: gated source detail.
- `/api/videos/:id/play`: exact same-origin protected media route, bearer attached only to this allowlisted native player request. Official public authority links use Android's external browser without a token.

Radio has one session owner: Start requests microphone permission and recording consent; silence detection or Send voice now ends a turn, transcription is sent to Jack, the cited answer plays, then the same radio session listens again. Stop Radio ends the session. Interrupt Jack stops playback and returns to listening. Navigation aborts the old context and restarts capture with the current context while retaining radio intent. Backgrounding or network loss pauses the session and requires an explicit restart. Silence detection is a conservative metering heuristic, capped at 55 seconds; an unvoiced capture is discarded without an STT request. Its performance on a noisy jobsite requires physical-device testing.

Source-video playback pauses/discards microphone capture and Jack audio while retaining radio intent; pausing/ending the source resumes capture only in the current foreground context. Text Ask/replay and explicit radio start pause any source video so video audio cannot become a spoken question.

The capability bus exposes only attached microphone/audio/source modules. Native microphone prepare/stop operations serialize; network/speech epochs suppress stale results after navigation, organization/session changes, backgrounding or interruption. Hardware permission errors produce an actionable paused state and a link to Android permissions.

## Local data and offline

Clerk's cache uses SecureStore only, with no plaintext fallback. Answers, questions, citations and source detail remain in memory; backgrounding, sign-out, organization change or session replacement clears sensitive state. There are no offline answers, background recordings, or queued writes in this slice. Network status is visible and reconnect does not automatically replay a prior request.

Audio must temporarily exist in the private app sandbox for native recording/playback. Speech files live in the dedicated `jack-private-audio` cache directory. Expo SDK 55 Android recordings use its private `cache/Audio/recording-<UUID>.m4a` location. Files are removed after upload/playback and on cancellation/sign-out; cold-start cleanup removes only owned media filenames **before** Clerk/private UI mounts, including crash leftovers. A cleanup failure blocks private UI. Android backups are disabled and protected video disk caching is disabled. This is bounded ephemeral media, not a durable offline knowledge store.

## Acceptance and limits

Core tests cover actual bearer/error contracts, token-delay cancellation, timeout ownership, native transition serialization, secure-cache failure, bounded UI context, protected media routes and owned crash-cleanup filenames. Typecheck and bundle/APK success are separate from real-device proof.

Before calling the slice complete, verify on a physical Android device: existing-account sign-in/sign-out/re-auth; approved/denied membership; text ask; microphone deny/revoke/regrant; transcription; multiple radio turns; canonical audible answer/replay/interrupt; video timestamp and knowledge/authority sources; navigation midrequest/capture/playback; background/foreground; network loss/reconnect; crash/relaunch; organization/user change and absence of previous-user audio/answers. The release owner records evidence in the existing issue-209 checkpoint. iOS has no build/device acceptance in this Android-first delivery.
