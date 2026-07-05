---
name: Graph selection — emphasis vs prune
description: In SpatialBrainCanvas, selection must not prune; pruning is isolated to recenterTo. Full Graph (default) vs Focus View.
---

# Living Memory graph: selection changes emphasis, not context

The live 3D brain is `SpatialBrainCanvas` (not the dead `MemoryGraphCanvas`). Two
independent mechanisms decide what the user sees:

- **Emphasis (non-destructive):** the per-frame `dimmed()` / `emphasized` logic
  dims everything except the selected node + its adjacency and brightens the
  selection/its edges. It operates on whatever nodes are currently live and
  hides nothing.
- **Pruning (destructive):** `recenterTo(id)` → `buildSpatialLayout(model, id,
  maxHops:2)` does a BFS window around the new center and sets `targetVis=0`
  (fade out, then delete) on everything outside it. This is the ONLY code path
  that makes nodes disappear.

**Rule:** if you want the full graph to stay visible, do NOT call `recenterTo`
on selection. Selecting a niche node used to recenter on it, so the other trades
fell outside the 2-hop window and vanished — the reported "critical regression."

**Design:** a `viewMode` prop gates the prune path.
- `"full"` (DEFAULT): layout stays centered on CORE and rebuilds from CORE with a
  finite large hop budget (`FULL_MAX_HOPS`, ~8) so the WHOLE graph stays live —
  all trade hubs + concepts. Selection is emphasis-only (never `recenterTo`).
  Instead of pruning, selection SWINGS THE CAMERA to the node (see camera-orient
  below) so an off-screen branch is reached by moving the view, not by hiding
  context.
- `"focus"`: legacy drill-in — selection recenters/prunes to the node's local
  neighborhood (2-hop). This is the intended way to reach a deep concept that is
  beyond CORE's window or the 220-node cap.

**Camera orient/swing (full mode):** there IS camera-easing infra now. A
`camTargetRef` holds a target `{yaw,pitch,zoom}` and the rAF loop eases toward it
(shortest-angle yaw wrap; snap+clear when close). `orientCameraTo(id)` aims the
orbit at a node using its LAYOUT target coords (`yaw=π−atan2(tx,tz)`,
`pitch=clampPitch(−atan2(ty,horiz))`, zoom nudged up); CORE→default framing.
`needsOrient(id)` = projected `depth>0` (far hemisphere) OR outside ~18% screen
margins. Wiring: full-mode `focusNode` (search-Enter / toast "jump") orients
always; full-mode `ensureVisible` (plain select) orients only if `needsOrient`.
Any manual input cancels the swing — `camTargetRef` is cleared on pointerdown, in
`applyZoom` (wheel/pinch/buttons), on reset, and on entering full mode.

**Why:** the default CORE view already shows Jack + all hubs + concepts; the user
wants that context preserved on selection. Keep full as the default so launch and
selection never hide trades.

**How to apply:** any future feature that reacts to selection (auto-focus, cross-
links, toast/search "jump") must check the mode — in full mode it may select
(emphasis) + orient the camera (`orientCameraTo` / `needsOrient`), but must NEVER
`recenterTo` (that prunes). Reach an off-screen full-mode branch by swinging the
camera, not by rebuilding the layout. Focus View remains the destructive drill-in
escape hatch for going past the 220-node cap.
