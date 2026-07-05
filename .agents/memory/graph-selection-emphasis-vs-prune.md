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
- `"full"` (DEFAULT): layout stays centered on CORE; selection is emphasis-only.
  All 12 trade hubs stay visible. `focusNode` is a layout no-op here.
- `"focus"`: legacy drill-in — selection recenters/prunes to the node's local
  neighborhood. This is the intended way to reach a deep concept that is beyond
  CORE's 2-hop window or the 220-node cap.

**Why:** the default CORE view already shows Jack + all hubs + concepts; the user
wants that context preserved on selection. Keep full as the default so launch and
selection never hide trades.

**How to apply:** any future feature that reacts to selection (auto-focus, cross-
links, toast/search "jump") must check the mode — in full mode it may select
(emphasis) but must not `recenterTo`. There is no camera-easing infra (camRef is
raw yaw/pitch/zoom), so a full-mode node outside the visible window just can't be
panned to yet; Focus View is the drill-in escape hatch. Don't build camera
animation unless asked.
