---
name: Core node visual primacy
description: Why the Jack core radius must stay above the largest growth-sized trade hub in the Living Memory 3D graph.
---

# Core node visual primacy (Living Memory graph)

The live 3D graph (`SpatialBrainCanvas.tsx`; `MemoryGraphCanvas.tsx` is dead) centers the CORE `__jack__` node at world origin, so Jack is always geometrically dead-center. Visual primacy, however, depends on Jack being the **largest** node, and that is NOT automatic.

**Rule:** the core base radius must stay clearly larger than the largest a trade hub can grow. Hubs are growth-sized: `topic radius = topicBase * (1 + weight*1.1)`, weight up to 1.0 for a fully-taught trade, so a maxed hub ≈ `topicBase * 2.1`. Keep `BASE_RADII.core` comfortably above that.

**Why:** growth sizing (the "knowledge-aware hub sizing" feature) skips the core (`spatialRadius` early-returns `base` for `kind === "core"`). When trades were empty, Jack was biggest by default. Once a real video populated one trade with many concepts, that hub outgrew the fixed core and became the visual center — Jack looked like a satellite even though it was still centered. Perspective makes it worse: a hub on the front of the hop-1 shell projects ~1.26× larger than the core at origin, so the core must beat the hub by more than the raw radius ratio.

**How to apply:** if you change `topicRadiusWeight`, the `*1.1` growth factor, `topicBase`, or the shell/focal/camera-distance constants in `graph-spatial.ts`, re-check that `core` still renders larger than a maxed hub at all zooms/angles. Prefer raising the fixed core over capping topic growth — capping compresses the intentional dormant→mature hub buckets. The core is a single anchor; raising it preserves both invariants.
