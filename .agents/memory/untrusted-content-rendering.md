---
name: Untrusted content rendering
description: Why AI/user-derived text in Jack must never be rendered as raw HTML.
---

# Untrusted content rendering

Video `analysis`/`keyPoints` and chat `content` are derived from **publicly uploaded** videos and public chat input (no auth gate on upload or chat). Treat all of it as untrusted.

**Rule:** render this content as text (React auto-escapes; use `whitespace-pre-wrap` to keep line breaks). Never pipe it through `dangerouslySetInnerHTML`.

**Why:** two components rendered server-returned content via `dangerouslySetInnerHTML` (video analysis, and chat messages via a `\n`→`<br/>` replace). Combined with the fully public upload path, that was a stored-XSS chain: an attacker could seed malicious markup into analysis/chat that executes for every viewer.

**How to apply:** if a design needs rich formatting (markdown), render through a sanitizing markdown component — do not inject raw HTML strings. The GPT `analysis` field is plain prose, so plain-text rendering is sufficient today.
