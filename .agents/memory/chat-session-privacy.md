---
name: Chat privacy without auth
description: How chat history stays private in a deliberately no-auth app, and the rule for any history-style endpoint.
---

# Chat privacy without auth

Jack has **no authentication by design** (a stated user preference in `replit.md`: no auth, billing, or multi-page nav). Privacy of chat history therefore rests entirely on the **session id**, which is a client-owned, unguessable token generated in the browser (`crypto.randomUUID`) and stored in `localStorage`. It is never rendered or shared.

**Rule:** any endpoint that returns chat history (or similar per-conversation data) MUST filter by `sessionId` and return nothing when no session is supplied. Never return a global/most-recent-across-all-sessions list.

**Why:** `/chat/history` originally selected the most recent messages with no session filter, so every visitor saw every other visitor's questions and answers — a cross-session information-disclosure leak. This matters especially because the app is public with no auth boundary.

**How to apply:** when adding or changing a history/list endpoint, require the caller's `sessionId`, `.eq("session_id", sessionId)` (or equivalent), and short-circuit to an empty result if it's missing. Do NOT "fix" this by adding auth — that contradicts the product preference; scope by client session instead.
