---
name: Radix ScrollArea horizontal overflow
description: Long text clipping/overflow on the right inside a shadcn/Radix ScrollArea comes from its display:table inner wrapper; force block so text wraps.
---

# Text clipping on the right inside a ScrollArea

**Symptom:** text (chat answer cards, transcripts, even the user's own message bubble) gets clipped on the right / overflows horizontally inside a `ScrollArea`, most visible on narrow/mobile widths. Content *outside* the ScrollArea (header/footer) renders fine — only the scrolling content clips, and every row clips at the same right edge.

**Cause:** Radix `ScrollArea.Viewport` wraps its children in an inner `<div style="min-width:100%; display:table">`. `display:table` shrink-wraps to the content's **max-content** width, so long text does NOT wrap — the wrapper grows past the viewport and overflows horizontally. The surrounding fixed / `overflow-hidden` container then clips the overflow on the right.

**Fix:** override that inner wrapper to a block in the shared `artifacts/jack-core/src/components/ui/scroll-area.tsx` Viewport className: `[&>div]:!block`. Radix's inline `min-width:100%` stays, so the wrapper fills exactly the viewport width and its children wrap normally. `!block` (display:block !important) beats Radix's inline `display:table` because inline styles without `!important` lose to `!important` rules.

**Why:** it presents as a per-component width bug, but it's a shared-primitive quirk — fixing it in the ScrollArea primitive fixes every consumer at once (chat, transcript, interview). Safe only while no ScrollArea relies on horizontal scrolling (none did).
