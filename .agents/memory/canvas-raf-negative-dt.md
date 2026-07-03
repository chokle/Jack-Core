---
name: Canvas rAF negative dt
description: requestAnimationFrame's first timestamp can precede a performance.now() baseline, producing a negative frame dt that breaks simulations.
---

# Canvas animation loop: guard against negative frame dt

In a `requestAnimationFrame` loop that computes `dt = (t - lastT)` where `lastT`
is seeded from `performance.now()` at setup, the *first* rAF timestamp `t` can be
slightly **earlier** than that baseline, so `dt` is negative on frame one.

**Why it bites:** any lerp/ease that uses `dt` as its step factor (e.g.
`radius += (target - radius) * min(1, k*dt)`) runs *backwards* on a negative dt.
A radius eased below zero then crashes `CanvasRenderingContext2D.arc()` with
"radius provided is negative".

**How to apply:** floor the frame delta — `dt = Math.min(cap, Math.max(0, (t - lastT)/step))`
— in any rAF loop. Capping the top end alone is not enough. As defense-in-depth,
wrap arc radii in `Math.max(0, r)` at draw sites that add offsets to a node radius.
