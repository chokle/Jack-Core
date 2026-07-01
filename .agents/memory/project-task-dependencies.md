---
name: Project task dependency editing
description: When task dependencies can and cannot be changed in the project task system
---

Dependencies on a project task can only be added or changed while the task is still in PROPOSED (draft) state. Once accepted (PENDING or later), `updateProjectTask` with `dependsOn` fails with INVALID_ARGUMENT ("must be PROPOSED"), even though title/description updates still apply in the same call.

**Why:** Hit when trying to make an accepted queue-visibility task depend on the accepted Knowledge Review task; the dep update failed but content updates went through.

**How to apply:** Declare all `dependsOn` at creation or before proposing. If ordering matters for already-accepted tasks, enforce it through the plan text instead (make the later task self-contained, tell it to reuse the other task's output only if it exists) — merges reconcile modest overlap.
