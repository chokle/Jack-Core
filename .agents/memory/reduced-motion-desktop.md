---
name: Reduced-motion desktop regression
description: When ambient canvas animations "work on mobile but not desktop", suspect OS prefers-reduced-motion, not layout.
---

# "Animates on mobile, frozen on desktop" is almost always reduced-motion

When several independent animations (e.g. an ECG heartbeat canvas and a neuron-firing canvas) all animate on a phone but appear frozen on desktop, the shared cause is almost always the OS **`prefers-reduced-motion: reduce`** setting — not a layout / z-index / overflow / zero-size wrapper.

**Why:** desktop OSes commonly ship with reduced-motion enabled (macOS "Reduce motion", Windows "Show animations off"), while phones usually don't. Any animation gated on `window.matchMedia("(prefers-reduced-motion: reduce)")` then silently disables itself on those desktops. Signature: a clipping/size bug blanks the canvas entirely, whereas reduced-motion leaves a *static* render — the ECG trace draws but the traveling pulse doesn't; nodes are visible but don't fire.

**Gotcha — headless/preview Chromium defaults to `reduce`:** the screenshot tool and many automated/preview browsers emulate `prefers-reduced-motion: reduce` by default. A static screenshot or a Playwright run therefore *reproduces the broken state* unless you set `page.emulateMedia({ reducedMotion: 'no-preference' })`. Conversely, if the animation shows up in a headless screenshot, it is genuinely running under reduce.

**How to apply — split motion into two tiers behind one shared module** (`artifacts/jack-core/src/lib/motion.ts`):
- transition / incidental motion (count-ups, slide-ins, width transitions) → honor the OS setting via `usePrefersReducedMotion()` / `prefersReducedMotion()`.
- signature *ambient* brand motion (ECG, neuron firing, background wallpaper) → gate on `ambientMotionEnabled()`, a product-owner switch (a single constant) that runs these small, non-vestibular effects regardless of the OS setting.

Route every animation's on/off decision through that one module so the policy lives in exactly one place. The bug arose because the decision was duplicated as inline `matchMedia` reads across five components plus a CSS `@media (prefers-reduced-motion)` block that killed the heart keyframes — fixing one spot left the others broken.
