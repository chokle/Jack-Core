# Jack Watch — Voice-First Companion

## Purpose

Jack Watch is a compact wearable surface for the same Jack intelligence used by Torch web, desktop, and phone. It is optimized for hands-busy work: fast voice input, immediate spoken output, glanceable text fallback, haptics, and clean handoff to a larger screen.

It is not a miniature chat app and should not require workers to read long conversations on a watch.

## Core interaction

Primary loop:
1. User invokes Jack.
2. Watch immediately shows a listening waveform/state instead of a text box.
3. User speaks naturally.
4. Audio is transcribed/processed through the shared Jack service.
5. Jack answers by voice as the primary output.
6. The answer transcript is retained as a compact fallback card so the worker can swipe to read it when the environment is too loud to hear.
7. Longer details, sources, images, or complex actions hand off to phone/desktop.

The watch UI should prioritize one-handed/voice use and should never require keyboard entry for the normal flow.

## Invocation ladder

Desired end state: custom wake phrase such as “Hey Jack.”

Do not make the first wearable release depend on background custom-hotword support that the target watch OS may not grant to ordinary third-party apps.

Use the fastest supported invocation available on each device, in this order:
- custom “Hey Jack” wake phrase where the OS/device legitimately supports it;
- assistant/deep-link integration where supported;
- hardware-button or configurable shortcut;
- watch complication/tile;
- single tap on the Jack presence surface.

Every fallback should land directly in LISTENING state with minimal intermediate UI.

## Phone-synced behavior

When a supported watch is paired with a phone running the Jack companion:
- authenticated Jack identity/session should be available to the watch through the supported secure companion channel;
- unread interventions and current task context can synchronize according to privacy scope;
- the watch should not require a separate Jack account setup after the approved phone-to-watch pairing flow;
- loss of phone connectivity must be explicit; never pretend a request reached Jack when it did not;
- capable standalone watches may talk to Jack directly over their own network connection.

For proprietary watches that cannot install a Jack app, fall back to notification/action relay from the phone rather than pretending native functionality exists.

## Voice-first UI states

IDLE
- tiny Jack presence/health indicator;
- no dense text.

LISTENING
- prominent live waveform/level indicator;
- clear stop/cancel affordance;
- haptic acknowledgement that Jack is listening.

THINKING
- restrained processing animation;
- no fake waveform;
- user can cancel.

SPEAKING
- audio-reactive output waveform;
- stop/pause/mute;
- swipe to transcript.

TRANSCRIPT
- compact readable answer text;
- preserve the latest answer so loud environments do not create a missed-answer backlog;
- swipe back to voice view;
- optional “Open on phone” / “More detail” action.

INTERVENTION
- haptic cue for material Jack-raised-hand events;
- one-sentence summary;
- listen, read, acknowledge, snooze, or hand off.

## Output policy

Voice is primary on the watch, but every substantive Jack answer should have a text representation available on demand.

Keep watch text concise by default. Do not stream walls of text onto the main voice screen.

If Jack’s answer exceeds the watch-safe presentation budget:
- speak the concise answer first;
- keep a short transcript summary on-watch;
- expose “More detail on phone” for the full response and provenance.

## Jobsite behavior

Design for gloves, noise, intermittent connectivity, and short attention windows.

Priorities:
- large tap targets;
- haptics for state transitions;
- strong contrast;
- quick cancel/retry;
- no fragile multi-step navigation;
- graceful offline/poor-signal state;
- avoid accidental microphone capture;
- do not retain raw watch audio longer than required by the approved voice-processing/retention policy.

## Standing intervention

Jack’s standing intervention authority applies to the wearable surface.

A material intervention can appear on the watch even when the user did not ask a question, subject to notification preferences and relevance. Examples:
- safety/code issue tied to the active task;
- source/authority degradation that changes confidence in an answer;
- prerequisite or task-context contradiction;
- urgent system or pilot issue relevant to the user.

Do not vibrate for routine telemetry noise.

## Cross-surface continuity

Jack Watch is a surface, not another Jack.

Preserve where authorized:
- identity and relationship;
- active task context;
- latest conversation turn;
- unread interventions;
- latest self-report/health state;
- handoff target to phone/desktop.

A worker should be able to ask on the watch, continue on the phone, and later inspect sources on desktop without re-explaining the question.

## Platform strategy

Tier 1 — notification relay:
- works with many proprietary watches through the paired phone;
- Jack intervention summary + basic actions where the watch supports them.

Tier 2 — actionable voice companion:
- supported watch can launch directly into Jack listening and return voice/text responses.

Tier 3 — native Wear OS/watchOS app:
- proper Jack presence, voice loop, transcript fallback, interventions, task continuity, and handoff.

Tier 4 — wake-word/assistant-grade presence:
- “Hey Jack” where platform permissions, battery behavior, privacy requirements, and distribution rules make it supportable.

## First implementation target

Target Wear OS first because it provides a practical native app path and voice-input APIs while preserving the Android phone companion route.

First acceptance slice:
1. Pair/auth continuity with Jack phone companion.
2. One-tap/tile launch directly into listening.
3. Live listening waveform.
4. Voice query to Jack.
5. Spoken response.
6. Swipe-to-read transcript fallback.
7. Material intervention notification with haptic.
8. “Open on phone” handoff preserving context.
9. Explicit offline/error states.
10. No dependency on unsupported background custom hotword detection.

## Long-term target

The intended experience is simple: Jack is already with the worker. The watch is the fastest doorway into him. When the platform allows it, saying “Hey Jack” should be enough; until then, invocation should be one gesture away and feel effectively immediate.
