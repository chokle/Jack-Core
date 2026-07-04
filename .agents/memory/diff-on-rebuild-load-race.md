---
name: Diff-on-rebuild load race
description: Effects that detect a state transition by diffing a freshly-rebuilt model against a stored "previous" ref will false-fire on initial data load unless gated on the queries having settled once.
---

# Diff-on-rebuild load race

An effect that fires a one-time animation/side-effect when an item transitions
(e.g. a trade hub going dormant → populated, "Jack just learned…") by comparing
`prevRef` to the newly built model must NOT treat the first data-bearing rebuild
as a set of real transitions.

**Why:** The view mounts before its React Query data resolves. The graph model is
first built from EMPTY in-flight query results (everything dormant/absent), which
seeds `prevRef` to the all-empty baseline. A moment later the real payload lands,
the model rebuilds, and every populated item shows a false empty→populated
transition — so a plain hard reload bursts/announces the entire graph at once. A
second poll can pile on a second wave. The old "seed silently on first mount"
guard is defeated because the first mount is the empty in-flight model, not the
real one.

**How to apply:** Thread the hook's `isLoading` into the component (`dataReady =
!isLoading`) and keep a `hasSettledRef`. Only emit the transition effect when
`dataReady && hasSettledRef.current`; always update `prevRef` regardless; set
`hasSettledRef = true` once a settled (non-loading) model has been recorded. This
makes BOTH a cold load and a warm re-mount (cache already hydrated) just seed the
baseline without firing, while genuine later transitions still fire exactly once.
`useMemoryGraphData` already returns `isLoading` for exactly this purpose.
