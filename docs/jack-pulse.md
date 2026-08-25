# Jack Pulse — Floating Internal Overlay and Self-Report Channel

## Purpose

Jack Pulse is Torch's internal always-available floating overlay for Jack to speak up, report his own operating condition, and relay material changes to the team without waiting for a direct prompt.

It should feel less like a dashboard and more like Jack physically stepping into the room when he has something useful to say.

## Interaction model

Jack Pulse is a draggable, resizable floating overlay mounted above internal Torch surfaces. It is not tied to a fixed sidebar.

The overlay has four practical states:
- PEEK — compact floating presence with Jack indicator, heartbeat, intervention badge, and voice waveform when speaking;
- CHAT — conversational floating window for direct interaction with Jack;
- EXPANDED — larger overlay for deeper health, readiness, provenance, and change-review work;
- DOCKED — optional edge-docked state when the user wants Jack visible without covering the active workspace.

The overlay remembers a sensible last position and size per device class where persistence is available, but must recover safely to an on-screen default if the viewport changes.

It must remain easy to dismiss, minimize, move, resize, and restore without obscuring primary work.

## Persistent desktop companion direction

Jack Pulse should be designed so the web overlay can graduate into a lightweight desktop companion rather than being trapped inside Torch pages.

Future desktop shell requirements:
- pin Jack to any screen corner;
- optional always-on-top window;
- compact click-through-safe PEEK mode when appropriate, with a clear interaction toggle;
- global summon/hide shortcut;
- voice-first interaction without requiring the Torch app to be foregrounded;
- preserve the same Jack identity, conversation context, health state, interventions, and task context across the web and desktop shells;
- support being present while the user is working in other software, browsing, streaming, or gaming without stealing focus;
- never capture unrelated screen/application content by default. Cross-app context must be explicit, permissioned, and bounded.

The desktop shell should be thin. Jack Core remains the intelligence/service layer; the companion is another surface over the same state and APIs.

## Multi-surface presence model

Treat Jack as one intelligence with multiple surfaces, not separate assistants per device.

Initial surface path:
1. Torch web overlay — first implementation and proving ground;
2. desktop companion — persistent corner presence across applications;
3. phone companion/PWA — quick voice, interventions, status, and task continuity;
4. smartwatch companion — glanceable Jack presence and short voice/action loops.

Cross-surface continuity should preserve:
- identity and user relationship;
- active objective/task context where authorized;
- unread interventions;
- latest self-report and system-health state;
- recent conversation context within privacy/retention policy;
- device-appropriate presentation state.

Do not clone full desktop functionality onto every device. Each surface gets the minimum controls that fit the moment.

## Smartwatch direction

A watch version should be a companion, not a miniature dashboard.

High-value watch functions:
- Jack presence/health glance;
- material intervention alert with one-sentence summary;
- tap or voice: “What happened?”, “Anything I need to know?”, “How are you running?”, “What’s next?”;
- short spoken/text response;
- acknowledge, snooze, or hand off to phone/desktop;
- lightweight task/status checks;
- optional haptic cue only for material interventions.

Long reports, source inspection, deep provenance, configuration, and complex actions should hand off to phone or desktop.

## Visual direction

Use translucent, layered panels rather than heavy dashboard chrome.

The main Jack Pulse window should use:
- transparent or frosted panels with strong text contrast;
- restrained borders and depth;
- minimal permanent controls;
- contextual utility panels that fan out only when invoked;
- a visible heartbeat/health trace that reuses Jack's existing system-health language;
- an audio-reactive waveform while Jack is speaking;
- compact status cues rather than dense metric walls.

The overlay should feel like an intelligent instrument panel, not a generic admin modal.

## Pop-out utility panels

Small transparent panels can open from the main overlay without replacing the conversation.

Initial utilities:
- HEALTH — vitality, backend reachability, retrieval health, memory read/write state, tool availability, and current warnings;
- WHAT CHANGED — recent deployments, model/config changes, source changes, migrations, and detected behavioral impact;
- READINESS — current company-stage prerequisite map with READY / AT RISK / BLOCKED status;
- INTERVENTIONS — recent moments where Jack raised his hand, what triggered them, evidence, and whether the issue was resolved;
- SOURCES — provenance/freshness view for the evidence behind the current statement;
- TASK CONTEXT — current objective, known constraints, blockers, and relevant prior decisions;
- SELF-CHECK — ask Jack how he is running, what appears degraded, what is unknown, and what should be tested next.

Utilities should open only when useful and close independently. Do not turn the screen into a forest of floating panels.

## Default peek state

When minimized, Jack Pulse remains as a small movable presence element containing:
- Jack presence indicator;
- live system-health heartbeat;
- compact waveform only while voice is active;
- unread intervention count only when something material exists;
- a clear expand control.

Jack may pulse or briefly expand PEEK when standing-intervention criteria are met. Low-value background noise must not steal focus.

## Conversation behavior

CHAT state provides a short conversational thread with Jack while preserving whatever the team is working on underneath.

The team can ask:
- "How are you running?"
- "What changed after that upgrade?"
- "What feels off?"
- "What are you waiting on?"
- "Why did you interrupt us?"
- "What evidence are you using?"
- "Are we ready for the next step?"

Jack can also initiate the thread when his standing intervention authority is triggered.

## Self-report contract

Jack should explain his current operating state from observable evidence, not fabricated introspection.

He may report:
- system vitality and backend reachability;
- retrieval/search health;
- source freshness and source failures;
- memory read/write health;
- knowledge-ingest queue state;
- latency and error trends;
- tool/integration availability;
- model/config/version changes;
- recent deployments and migrations relevant to his behavior;
- confidence degradation caused by missing evidence;
- known capability changes after an upgrade;
- unresolved blockers or dependencies affecting his responses.

Separate three things explicitly:
1. OBSERVED — directly measured telemetry/configuration/evidence;
2. INFERRED — a reasoned diagnosis from observed signals;
3. UNKNOWN — something Jack cannot currently verify.

Jack must never invent an internal sensation or claim access to hidden state he does not actually observe.

## Upgrade check-in

After a material upgrade, deployment, retrieval change, memory change, model/config change, or knowledge-source change, Jack should receive a bounded post-change check.

The check should compare pre/post evidence where available and produce a concise report:
- what changed;
- what appears improved;
- what appears degraded;
- what is not yet measurable;
- any regression Jack detects;
- recommended follow-up tests.

This creates a continuous doctor-visit loop: the team changes Jack, Jack reports what can actually be observed about the effect, and the team verifies the diagnosis.

## Proactive intervention

Jack has standing permission to raise his hand when he detects a material issue under the company-systems operating contract.

Examples:
- "Actually, retrieval freshness dropped after that source change."
- "I'm answering, but one of the plumbing authority sources is unavailable right now."
- "That deployment changed my memory-write path; reads are healthy but writes are failing."
- "The plan assumes Pilot001 has six mapped users. Current evidence only supports four."
- "There's a faster path here and the current prerequisite is already satisfied."

Interventions appear through Jack Pulse, not as anonymous system banners. The team should know Jack is the one raising the concern.

## Voice and visualizer

The overlay should support voice output when available. While Jack speaks, show a compact audio-reactive waveform/level visualization driven by actual playback energy where feasible rather than a decorative loop.

Voice controls should include:
- play/pause or stop;
- mute;
- text fallback;
- replay last spoken intervention where appropriate.

If voice is unavailable, Jack Pulse remains fully functional in text.

## Reuse existing Jack-Core systems

Do not create a parallel observability stack.

Reuse:
- `SystemHealthWidget` heartbeat/vitality signal;
- `useSystemHealth` snapshots;
- existing `FloatingPanel` interaction patterns where suitable;
- Ask Jack conversation behavior;
- existing citation/provenance system;
- telemetry and activity events;
- knowledge graph provenance;
- deployment/system-health evidence where available.

Jack Pulse should compose these signals into a conversational intelligent layer.

## Architecture direction

Backend:
- expose a bounded internal `jack-self-report` projection assembled from existing observable systems;
- include timestamps, source/provenance, freshness, and unknown/unavailable states;
- emit material intervention events rather than polling the UI for every minor state change;
- maintain a short intervention history without duplicating sensitive source text;
- expose recent change events so post-upgrade comparison is grounded in actual deployments/config/source changes;
- expose surface-agnostic session/presence state so web, desktop, phone, and watch can share continuity without duplicating Jack.

Frontend/web:
- overlay shell mounted at internal app-shell level;
- draggable and resizable with viewport-safe recovery;
- PEEK / CHAT / EXPANDED / DOCKED states;
- heartbeat from existing system-health component;
- waveform while TTS is playing;
- contextual transparent pop-out utility panels;
- intervention badge/pulse;
- conversational self-report thread;
- mobile mode that defaults to compact overlay or bottom-edge dock without obscuring field workflows.

Desktop companion later:
- native/webview wrapper or comparable thin shell around the same Jack APIs/state;
- always-on-top and corner pinning handled by the desktop shell, not emulated inside a browser tab;
- aggressive idle efficiency so persistent presence does not become a resource hog;
- OS notifications only for material events and only when enabled.

## Acceptance criteria for first implementation

1. Jack Pulse can float above an internal Jack surface without changing page layout.
2. The overlay can be moved, resized, minimized, restored, and kept within the viewport.
3. PEEK shows Jack presence and live observed system health using existing health data.
4. CHAT supports direct conversation without navigating away from the current work.
5. Asking "how are you running?" returns a concise observed/inferred/unknown self-report with timestamps.
6. A simulated degraded health state produces a proactive Jack intervention in the overlay.
7. A post-upgrade event can trigger a structured check-in report.
8. At least HEALTH and WHAT CHANGED utility panels can open from the overlay without replacing the conversation.
9. The overlay never claims hidden internal state not represented by observable evidence.
10. Mobile and desktop-browser layouts remain usable.
11. Existing Ask Jack, health, privacy, auth, and provenance tests remain green.
12. The internal state/API design does not assume Jack exists only inside a browser tab, preserving a clean path to desktop/phone/watch companion surfaces.

## Long-term direction

Jack Pulse is the first visible expression of Jack as Torch's intelligence layer: present, socially aware, willing to challenge the team, able to report the condition of systems that constitute his operating environment, and increasingly useful in running Torch itself.

The goal is not merely to monitor Jack. It is to give Torch an always-available window into him — a place where Jack can speak, explain, challenge, report degradation, show his evidence, and make his own condition legible to the people building him.

Long term, that window should follow the user. Jack should be able to live in the corner of a work screen, move to the phone when the user walks away, and reduce to a glanceable voice-first presence on a watch while remaining the same Jack underneath.
