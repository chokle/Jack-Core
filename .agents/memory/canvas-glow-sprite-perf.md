---
name: Canvas per-node glow sprite perf
description: Why the force-directed graph canvas stalls at full zoom on large graphs, and the pre-rasterized glow-sprite fix that preserves the look.
---

# Per-node radial-gradient glow is the canvas scaling bottleneck

On the Living Memory graph canvas, the frame-rate cliff on large graphs (1000+
visible nodes) at full zoom is NOT the physics — spatial-grid repulsion + viewport
culling already keep the sim near O(n). The cost is the **draw loop**: building a
fresh `createRadialGradient` and filling a large arc for every visible node every
frame (a gradient object alloc + a per-pixel shader pass under the additive
`lighter` composite).

**Why the existing glow LOD didn't cover it:** the LOD skipped small-node glows
only when `cam.scale < ~0.55`. At full zoom every visible node is above that, so
the whole crowd pays the gradient cost. A scale-only LOD can't fix the
dense-cluster-at-full-zoom case.

## The fix: cache one glow sprite per color, blit with drawImage
Pre-rasterize a single soft radial-glow sprite per color into an offscreen
canvas (bake the exact gradient stops at intensity 1), memoize by RGB key, and in
the hot path draw it with `drawImage(sprite, x-glowR, y-glowR, glowR*2, glowR*2)`
using `globalAlpha = intensity` instead of a per-frame gradient.

**Equivalence (the non-obvious part):** under `globalCompositeOperation="lighter"`,
a sprite baked at `rgba(col, a)` drawn with `globalAlpha=intensity` contributes
`col·a·intensity` — identical to the old `fillStyle=gradient rgba(col, a·intensity)`
arc fill. So it's a visually-lossless swap, not a downgrade. Bake the gradient to
reach alpha 0 at the inscribed circle so the sprite's square corners are
transparent and the blit reads as a circle.

## Constraints when applying this
- **Variable / >1 intensity nodes must stay on the gradient path.** `globalAlpha`
  caps at 1, so emphasized/selected/pulsing nodes (whose intensity exceeds 1)
  can't be reproduced by a sprite+globalAlpha. Keep those on the exact per-frame
  gradient — there are only ever 1–2 on screen, so it's cheap.
- **Save/restore `globalAlpha` around the blit.** Anything drawn later in the same
  pass (e.g. a birth-burst flare) assumes `globalAlpha === 1`.
- **Guard `glowR <= 0`** (first-frame grow can be 0) — `drawImage` with 0 size is a
  no-op but skip it anyway.
- Cache is bounded by the color palette (kind colors + topic palette + a couple of
  overrides) → a few dozen small sprites; scope it to the component so it releases
  on unmount.

**How to apply — check which component is actually mounted first.** The sprite fix
currently lives ONLY in `MemoryGraphCanvas.tsx`, which is now **dead code**: the
Memory Graph view renders `SpatialBrainCanvas.tsx` instead (a "drop-in sibling",
MemoryGraphView.tsx), and `MemoryGraphCanvas` is referenced only in comments. So
the optimization is absent from the path users see — the "spatial brain" rewrite
silently reintroduced the per-node `createRadialGradient` glow. Any glow-perf work
(the sprite technique included) must land in the RENDERED canvas to matter.

**Nuance — the live cost is bounded, not the pre-#84 unbounded cliff.**
`SpatialBrainCanvas` imports nothing from `graph-perf.ts` (no screen-cull, no glow
LOD) and its `drawn` set is filtered only by `n.vis`, BUT `graph-spatial.ts` caps
the visible set at `DEFAULT_MAX_VISIBLE = 220`, so it draws at most ~220 per-node
gradients/frame. Don't claim a *measured* fps regression from the code alone — the
per-node pattern is present but capped.

Empirical FPS can't be measured in the headless preview screenshot tool (CPU-
rasterized, underreports vs a real GPU browser). A dev-only on-screen fps meter now
lives in `SpatialBrainCanvas` (enable with `?graphStress=N` or `?fps=1`); verify
render correctness with `?graphStress=N` and read real fps in a desktop browser at
full zoom (a dense cluster filling the viewport — the worst case, not default zoom).
