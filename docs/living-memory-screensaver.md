# Living Memory screensaver mode

Pilot/UI behavior for `SpatialBrainCanvas`.

## Trigger

- Enter screensaver mode after 30 seconds with no pointer, touch, wheel, keyboard graph control, zoom, or selection activity.
- Exit immediately on any user interaction.
- Restart the 30-second idle timer after the interaction ends.
- Respect reduced-motion preferences: no auto-orbit or random pulse animation when ambient motion is disabled.

## Idle motion

- Apply a very slow yaw-only orbit around the current camera target/branch.
- Do not recenter the graph or collapse the current branch.
- Do not apply pitch or zoom drift.
- Never apply auto-orbit while a user gesture, pinch, camera swing, or manual zoom is active.

## Memory spotlight

While screensaver mode is active:

- Select one currently visible non-core memory node at a time.
- Prefer populated knowledge nodes; avoid repeating the immediately previous node.
- Pulse the selected node using the existing Living Memory glow language.
- Show one translucent, non-interactive bubble near the node.
- Bubble text source order:
  1. `node.capture.summary`
  2. `node.meta.description`
  3. node label only when no summary text exists
- Keep copy short and clamp visually so the overlay never obscures the graph.
- Rotate to a different eligible memory after a calm interval; never stack multiple bubbles.
- Clear the bubble and pulse instantly on user interaction.

## Acceptance

1. Wait 30 seconds on the core graph: slow orbit begins.
2. Touch/drag: orbit stops immediately and never fights the gesture.
3. Wait 30 seconds again: orbit resumes.
4. Open any trade/branch and wait 30 seconds: the current branch remains open while orbit resumes.
5. During idle, one populated node at a time pulses and surfaces its captured summary in a translucent bubble.
6. User interaction immediately removes the spotlight bubble and restores full control.
7. Reduced-motion mode suppresses screensaver animation.
