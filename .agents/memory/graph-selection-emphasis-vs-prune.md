---
name: Graph selection — emphasis vs prune
description: Selecting a node in the Living Memory graph must dim other trades but keep them visible; it must never prune/hide context. The proven 2D MemoryGraphCanvas is live; the 3D SpatialBrainCanvas experiment is dead-on-disk.
---

# Living Memory graph: selection changes emphasis, not context

**Durable rule:** clicking a trade must BRIGHTEN it + its direct neighbors
(concepts / procedures / tools / hazards / mentors / competencies) and DIM every
other trade to a faint background — other trades stay visible, never removed. Any
feature that reacts to selection (auto-focus, cross-links, toast/search "jump")
may re-emphasize and pan the view, but must NEVER rebuild the layout around the
selection in a way that drops other trades out of view.

**Why:** the default view already shows Jack + all hubs + concepts; users read the
whole map for context. A selection that prunes to a local neighborhood makes the
other trades vanish — repeatedly reported as a critical, launch-blocking
regression.

## Which canvas is live
The proven interaction lives in the **2D `MemoryGraphCanvas.tsx`** (force-directed):
`related = adj.get(selectedId)` over a bidirectional adjacency of all edges
brightens the selection + its neighbors; `dimmed()` fades everything else to
~alpha 0.03 but keeps it drawn; the core hex is pinned to screen center and
excluded from repulsion, so clusters spread around it and it never overlaps nodes.
`MemoryGraphView.tsx` renders this canvas, and it is what ships for launch.

A **3D `SpatialBrainCanvas.tsx`** experiment replaced it for a while but its camera
always orbited the layout origin (Jack stuck screen-center, occluding branches on
zoom), and its "focus" path pruned on select and hid trades. It was rolled back to
the 2D canvas for launch and is now **dead-on-disk**, pending a deliberate
post-launch 3D revisit. If you resurrect 3D, preserve the emphasis-not-prune rule
above and keep every trade reachable by moving the view, never by hiding the rest.
