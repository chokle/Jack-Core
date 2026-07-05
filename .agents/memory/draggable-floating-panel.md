---
name: Draggable floating panel positioning
description: Why a pointer-dragged overlay must drive its transform imperatively from a ref, not React state.
---

# Draggable floating panel positioning

A draggable overlay window (dragged by its header via Pointer Events) must NOT
read its position from React state into the JSX inline `style.transform`. Drive
the transform imperatively — write `el.style.transform` from a `posRef` inside
your own layout effects and pointer handlers, and keep `transform` out of the
`style` object entirely.

**Why:** during a drag, any unrelated parent re-render (polling intervals,
toasts, zoom-level state) re-applies the stale committed `pos`, snapping the
panel back to where the drag started until the next pointermove fires. A ref is
the single source of truth that React re-renders cannot clobber.

**How to apply:** applies to any pointer-dragged floating element whose parent
re-renders mid-drag (the Jack Living Memory node-inspector FloatingPanel is the
canonical case — its host polls knowledge stats ~every 8s and fires learning
toasts). Re-clamp the stored position on initial mount, stage resize, AND
content-height change (a taller body can push the panel past the stage edge).
Persist only `{x,y}`, and commit + persist on pointerup, not on every move.
