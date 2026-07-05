---
name: flex-wrap row with min-w-0 flex-1 doesn't wrap on narrow screens
description: An input+icon-buttons row using flex-wrap with a flex-1 min-w-0 item can shrink to near-zero instead of wrapping, making adjacent icon buttons look pasted on top of the input at 320-375px.
---

# Symptom

A header row like `search-input (flex-1 min-w-0) + several fixed-size icon buttons (shrink-0)` inside a `flex flex-wrap gap-2` container. On desktop it looks fine. At 320-375px it doesn't cleanly wrap the icon buttons to their own line — instead the flexible input shrinks to whatever `min-w-0` allows (near 0), and the fixed buttons end up visually crammed against/over the collapsed input.

# Cause

`flex-wrap` decides whether to start a new line based on each item's *base size*. With `min-w-0`, the flexible item's minimum content size is ~0, so the browser doesn't consider it "too big to fit" and keeps everything on one line, squeezing the flexible item instead of wrapping.

# Fix

Give the flexible item a real `min-w-[Npx]` (not `min-w-0`) sized to the smallest acceptable input width (e.g. `min-w-[160px]`). Once the sum of that minimum plus the fixed siblings exceeds the container width, `flex-wrap` correctly drops the fixed siblings to a new line instead of over-compressing the input.

**How to apply:** any responsive `flex flex-wrap` row mixing a shrinkable/growable item with several `shrink-0` fixed items — set a real minimum width on the growable item, verify by screenshotting at 320px specifically (375px can look fine while 320px still breaks).
