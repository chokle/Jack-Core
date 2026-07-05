---
name: Blue crosshair canvas artifact
description: The intermittent full-viewport blue vertical+horizontal line on non-graph pages — its mechanism class, what was ruled in/out, and how to decisively bisect it if it recurs.
---

# The intermittent "blue crosshair" on non-graph pages

Symptom: a bright blue vertical + horizontal line spanning the whole viewport, seen intermittently on the Library (and other non-graph) pages. Never reproducible in static screenshots (mobile 534px and desktop 1280px Library captures were clean) — it only appears on rare frames, so it is a transient, not a steady artifact.

## Mechanism class (canvas gradient spike)
A canvas gradient whose axis is **finite but degenerate** (zero-length linear axis, or coincident equal-radius circles) gets extrapolated by Chrome/Skia into a canvas-spanning spike. This is the confirmed cause of the same artifact on the graph page, fixed in `MemoryGraphCanvas` by the guarded `pulseSegment()` helper (`lib/memory-graph-pulse.ts`) which returns null for degenerate linear-gradient geometry.
**Important nuance:** *non-finite* args to `createLinearGradient`/`createRadialGradient` (or a negative radius) THROW (TypeError/IndexSizeError) and would freeze the rAF loop — they do NOT paint a spike. Only finite-but-degenerate geometry spikes. So a NaN-guard is not the real fix; a zero-length/coincident-axis guard is.

## Suspected source on non-graph pages
`KnowledgeGraph.tsx` — a legacy full-viewport ambient "wallpaper" canvas (`fixed inset-0`, z-0, `pointer-events-none`), mounted in `App.tsx` as `{!inGraph && <KnowledgeGraph/>}`, so it renders on every non-graph page and is the ONLY full-viewport canvas there. `COL_COMPETENCY = [126,169,222]` is the only blue paint on those pages. This localization is **circumstantial, not proven** — the crosshair was never reproduced.

## What was ruled OUT (do not re-investigate without new evidence)
- KnowledgeGraph's radial glow `createRadialGradient(n.x,n.y,0,n.x,n.y,glowR)` is r0=0,r1>0 concentric — the normal safe case, NOT degenerate. glowR ≥ ~4.8px always (baseRadius ≥ 2.4 × pulse ≥ 0.92 × (0.4+0.6·grow) × 5). Node positions can't go non-finite (repulsion d2 clamped ≥ 0.01, velocity clamped to MAX_SPEED=3 each step, dt clamped ≤ 2). So finite/degenerate can't arise here by the code's own math.
- Edges are plain `rgba` strokes (not gradients) — a non-finite `lineTo` is a silent no-op, never a spike.
- Node overlap does NOT degenerate a per-node radial gradient (each depends only on its own x,y,glowR), so the coincident-spawn theory does not explain the crosshair.

## The one real bug that WAS fixed
`sizeRef` was seeded `{w:1,h:1}`; the graph-construction effect runs BEFORE the render-loop effect's `resize()`, so on every mount of a non-graph page all non-core nodes spawned in a pile at the top-left corner and visibly drifted out for the first seconds. Now seeded from live `window.innerWidth/innerHeight`. Worthwhile regardless, but it is NOT confirmed to be the crosshair.

## The SEPARATE "far-left thin blue vertical line" on the graph page (SOLVED — was NOT canvas)
Different artifact from the crosshair above: a steady thin blue vertical line pinned to the FAR LEFT of the Living Memory graph stage, present in every state (idle/animating/panned/zoomed/reduced-motion/locked). Root cause was NOT the canvas at all — it was the `JackShell` sidebar's `border-r border-sidebar-border` (token `--sidebar-border: 217.2 32.6% 17.5%`, hue 217 = slate-blue) sitting exactly at the graph stage's left edge. Fix: drop the `border-r` (the sidebar's `bg-sidebar/85` panel already reads as distinct).
**Decisive principle (use this first next time):** a line that stays IDENTICAL across pan/zoom/lock CANNOT be canvas-drawn content — canvas content transforms with the camera. So it's DOM/CSS, not the draw loop. Confirm in one shot by temporarily recoloring the suspected DOM border bright red and screenshotting.
**Don't repeat the wasted path:** instrumenting the canvas draw loop (edge/pulse span detector) proved the max stroke was only ~300px vs an 720–870px span — i.e. no canvas primitive spans the axis. Edges/pulses are the ONLY strokes; everything else is circle/rect/full-bg fills. Skip that and check DOM borders first when the line is state-invariant.

## The THIRD "blue line" — Replit preview-pane focus outline (NOT the app at all)
A user reported a blue line that "pops up when moving the cursor from the far-left edge toward the window, never from the right," the same on every page, only in Jack (not on a blank browser tab). This turned out to be the **Replit workspace's preview-pane focus/active highlight**, not Jack code. A screen recording (extract frames with `ffmpeg -vf fps=3`) showed a bright blue L-shaped ring flashing along the **left+top edges of the preview iframe** the instant the cursor crossed into the preview from the chat side, then fading.
**Decisive tells (use these to short-circuit next time):**
- The ring outlines the **iframe's outer boundary** (a full top+left corner at the exact pane edge). Content *inside* an iframe cannot paint its own outer border — so a boundary ring is parent-drawn = Replit chrome, never app code.
- "Left only, never right": the preview pane is on the right; you can only enter it by crossing its left edge (its right side is the window edge).
- "Not on a blank tab": a plain tab isn't inside the preview pane. It flashes for ANY app in the preview, not just this one.
- Color is Replit's bright accent blue (~#0079F2), distinct from Jack's orange primary and muted slate-blue COL_COMPETENCY.
It will NOT appear in the deployed app or when opening the app URL directly in a browser tab. Nothing to fix in code. Ask for a screen recording early when a "cursor-triggered" line is reported — it settles app-vs-workspace in one look.

## If it recurs — decisive next step (do this BEFORE adding more guards)
Bisect empirically, don't pile on inert guards:
1. Temporarily `display:none` (or unmount) the `KnowledgeGraph` wallpaper and have the user confirm the crosshair's presence/absence over time. This proves/disproves this canvas as the source in one step.
2. Check the DevTools console for canvas exceptions during the artifact (an exception = frozen canvas theory, points elsewhere).
3. If the canvas is exonerated, next suspects are DOM/CSS hairlines (borders/pseudo-elements in `index.css`) and canvas resize/DPR transform timing — NOT gradient geometry.
