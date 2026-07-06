---
name: Cascading toast/list-item exit animation
description: How to make several auto-dismissing UI items (toasts, banners) leave one-at-a-time in order instead of all at once.
---

When multiple auto-dismissing items (e.g. toast notifications) can expire at
nearly the same moment — most commonly because they were all created together
in one batch — a per-item independent timer is not enough to guarantee a
readable "leave in order, one at a time" cascade: their timers fire in the
same tick and the exit animations overlap.

**Pattern:** decouple "this item's lifetime is up" from "this item is now
playing its exit animation."

- The item's own timer only reports **expired** to the parent (`onExpire`),
  it does not start its own exit animation.
- The parent holds the ordered list of items (already oldest-first by
  insertion order) plus a `readyIds` set (expired, waiting) and an
  `exitingIds` set (currently animating out).
- A single scheduler effect in the parent finds the oldest item that is ready
  but not yet exiting, and — respecting a minimum gap since the last cascade
  step — flips it into `exitingIds`. That state drives the item's exit CSS
  class via a prop.
- The item only removes itself from state once its own exit animation's
  duration has elaped, exactly as before — only the trigger for *when* the
  exit starts moved to the parent.

**Why:** a naive "each item manages exiting locally on its own timer" design
is invisibly broken for the batch case — it works fine when items are added
minutes apart but silently fails (loses the intended stagger) the moment
several are created in the same instant, which is often the most common case
in practice (e.g. one event producing several linked notifications).

**How to apply:** any time a request asks for toasts/items to "leave in the
order they appeared" or "cascade" or "not all at once" — check whether items
can be created in the same batch/tick, and if so use this parent-scheduler
pattern rather than relying on independent per-item timers to produce the
ordering.
