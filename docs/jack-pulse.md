# Jack Pulse — Internal Sidecar and Self-Report Channel

## Purpose

Jack Pulse is Torch's internal always-available sidecar for Jack to speak up, report his own operating condition, and relay material changes to the team without waiting for a direct prompt.

It should feel less like a dashboard and more like Jack raising his hand.

## User experience

A small collapsible side window is available across internal Torch surfaces.

Default collapsed state:
- Jack presence indicator;
- live system-health heartbeat;
- small voice/waveform visualizer when Jack is speaking;
- unread intervention count only when something material exists.

Expanded state:
- short conversational thread with Jack;
- current self-report in plain language;
- recent interventions;
- recent upgrade/change events;
- health evidence and provenance on demand;
- ask-Jack input for "how are you running?", "what changed?", "what feels off?", "what are you waiting on?", and similar questions.

Jack may proactively open or pulse the sidecar when standing-intervention criteria are met. Low-value background noise must not steal focus.

## Self-report contract

Jack should be able to explain his current operating state from observable evidence, not fabricated introspection.

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

This creates a continuous "doctor visit" loop: the team changes Jack, Jack reports what can actually be observed about the effect, and the team verifies the diagnosis.

## Proactive intervention

Jack has standing permission to raise his hand when he detects a material issue under the company-systems operating contract.

Examples:
- "Actually, retrieval freshness dropped after that source change."
- "I'm answering, but one of the plumbing authority sources is unavailable right now."
- "That deployment changed my memory-write path; reads are healthy but writes are failing."
- "The plan assumes Pilot001 has six mapped users. Current evidence only supports four."
- "There's a faster path here and the current prerequisite is already satisfied."

## Voice and visualizer

The sidecar should support voice output when available. While Jack speaks, show a compact audio-reactive waveform/level visualization rather than a decorative animation.

If voice is unavailable, the sidecar remains fully functional in text.

## Reuse existing Jack-Core systems

Do not create a parallel observability stack.

Reuse:
- `SystemHealthWidget` heartbeat/vitality signal;
- `useSystemHealth` snapshots;
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
- maintain a short intervention history without duplicating sensitive source text.

Frontend:
- sidecar shell mounted at internal app-shell level;
- collapsed/expanded states;
- heartbeat from existing system-health component;
- waveform while TTS is playing;
- intervention badge/pulse;
- conversational self-report thread;
- mobile behavior that does not obscure primary field workflows.

## Acceptance criteria for first implementation

1. Jack Pulse can be opened from the internal Jack shell.
2. It displays live observed system health using existing health data.
3. Asking "how are you running?" returns a concise observed/inferred/unknown self-report with timestamps.
4. A simulated degraded health state produces a proactive intervention in the sidecar.
5. A post-upgrade event can trigger a structured check-in report.
6. The sidecar never claims hidden internal state not represented by observable evidence.
7. Mobile and desktop layouts remain usable.
8. Existing Ask Jack, health, privacy, auth, and provenance tests remain green.

## Long-term direction

Jack Pulse is the first visible expression of Jack as Torch's intelligence layer: present, socially aware, willing to challenge the team, able to report the condition of systems that constitute his operating environment, and increasingly useful in running Torch itself.
