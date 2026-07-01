---
name: Chat privacy without auth
description: How chat history stays private in a no-auth app via server-issued HttpOnly cookies.
---

# Chat privacy without auth

Jack has **no authentication by design** (a stated user preference in `replit.md`: no auth, billing, or multi-page nav). Privacy of chat history rests on **server-issued HttpOnly session cookies** — the server mints the session UUID on first `/api/chat` request, sets it as `jack_session` (HttpOnly, SameSite=Strict, Path=/api), and never accepts a session identifier from the request body or query string.

**Rule:** Session identity is always derived from the HttpOnly cookie (`req.cookies["jack_session"]`). Any attempt to pass a `sessionId` in the request body is silently ignored. Any history endpoint must use the cookie value — never a caller-supplied parameter.

**Why:** The original design trusted a caller-supplied `sessionId` from the request body, making every valid UUID a potential session hijack vector: if an attacker knew another user's UUID they could read prior messages and inject new ones. Moving ownership to the server-set cookie means only the originating browser possesses the credential.

**How to apply:**
- `POST /api/chat` — call `resolveSession(req, res)` which reads the cookie (or sets a fresh UUID cookie and returns it); never read `sessionId` from `req.body`.
- `GET /api/chat/history` — read `req.cookies["jack_session"]`; return `[]` if absent.
- The client (`AskJack.tsx`) sends no session identifier; the browser cookie is included automatically on same-origin requests.
- `ChatInput`, `ChatResponse`, and `ChatMessage` OpenAPI schemas have no `sessionId` field.
- `GET /chat/history` OpenAPI path has no `sessionId` query param.
- After any OpenAPI schema change, run `pnpm --filter @workspace/api-spec run codegen`.
