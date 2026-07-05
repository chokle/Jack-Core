---
name: Eliminate a nested/double scroll trap by making the inner container auto-height on mobile
description: A sidebar/panel with a fixed h-[calc(100vh-Npx)] plus an inner ScrollArea/overflow-y-auto creates a second independent scroll region; on mobile, drop the fixed height so the inner scroller collapses to content height and the outer page becomes the single scroll owner.
---

# Symptom

A detail page has a main content column (`overflow-y-auto`) next to a sidebar panel that has its own fixed height (`h-[calc(100vh-Npx)]`) and its own internal scroller (Radix `ScrollArea` or `overflow-y-auto`). On desktop this is the intended two-pane layout. On mobile, once the layout stacks to a single column, the two independently-scrolling regions create a confusing "scroll trap" — scrolling inside the sidebar area doesn't move the page, and vice versa.

# Fix

Make the constraining height and the inner scroll `lg:`-only (or whatever breakpoint the two-pane layout kicks in at):
- Outer row: `overflow-y-auto lg:overflow-hidden` (single scroll owner on mobile, two independent panes on desktop).
- Main content pane: `flex-1 lg:overflow-y-auto` (no independent scroll on mobile).
- Sidebar pane: `lg:h-[calc(100vh-Npx)]` instead of an unconditional fixed height (auto height on mobile).
- Radix `ScrollArea` wrapper: add `overflow-visible lg:overflow-hidden` to its className. Radix's `Viewport` is hardcoded `h-full w-full`, which resolves against the Root's height; when the Root has no explicit height (auto, on mobile) percentage heights compute to `auto` per CSS spec, so the viewport stops imposing its own scroll — content just flows into the page's single scroll region.

**Why:** the two-pane desktop design and the single-column mobile flow have fundamentally different scroll ownership; you can't fix it by tweaking one container in isolation, all three constraints (outer overflow, inner overflow, sidebar fixed-height) have to flip together at the same breakpoint.

**How to apply:** any responsive layout where a fixed-height side panel with its own scrollbar exists next to a scrollable main area, and stacks to one column on mobile.
