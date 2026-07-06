---
name: Chat privacy — account-scoped
description: How chat history stays private, now tied to the signed-in Clerk account (not the device cookie).
---

# Chat privacy — account-scoped

Since auth was added, the whole `/api` surface sits behind `requireAuth`, which sets `req.userId` (the server-derived Clerk user id). **Chat ownership is now the Clerk user id**, not the device-scoped `jack_session` cookie. History follows the account across devices/browsers and never leaks to another user signed in on the same device.

**Rule:** Scope every chat read/write by `req.userId` (never a client-supplied field). `chat_messages.user_id` is the owner column; `session_id` is retained (still populated from the HttpOnly cookie for continuity) but is NOT the ownership key.

**Why:** The old design scoped chat purely by the `jack_session` cookie. Cookies are per-device, so two Clerk users on the same browser would share one cookie and see each other's history; and history didn't follow a user to another device. Tying ownership to the authenticated user fixes both and never returns global/other-user rows.

**How to apply:**
- `POST /api/chat` — read `userId = req.userId`; 401 fail-closed if absent (unreachable behind `requireAuth`, but never write an unowned row). Load the conversation-context history with `.eq("user_id", userId)`; insert new rows with `user_id: userId` (plus `session_id`).
- `GET /api/chat/history` — read `req.userId`; return `[]` if absent; query `.eq("user_id", userId)`.
- Legacy pre-auth rows have `user_id = NULL`; the `.eq("user_id", …)` filter naturally excludes them (they are never returned as global rows). `user_id` is a NULLABLE column only so those legacy rows stay valid.
- The response never echoes `session_id`/`user_id` (server-side identity only).
- The client (`AskJack.tsx`) sends no session/user id — auth credentials ride same-origin requests automatically.
- Router unit tests mount the bare router (no `requireAuth`), so they must set `req.userId` in a stand-in middleware (see `chat.privacy.test.ts`, and the `makeApp` middleware in the chat rerank/trust-contract/retrieval-rerank tests).
- Schema: `chat_messages.user_id TEXT` + `idx_chat_user`, added idempotently (`ADD COLUMN IF NOT EXISTS`) in `scripts/src/supabase-schema.sql`; re-run `setup:supabase` on existing installs.
- **E2E verification gotcha:** a preview/dev environment that hasn't re-run `setup:supabase` since this column was added will 500 on `/api/chat/history` ("column chat_messages.user_id does not exist") even though the code is correct — that's schema drift, not a bug; run the migration before trusting a live test. Verified live via the testing skill's Clerk auth override (`testClerkAuth: true`): same account across two `[New Context]` browsers sees shared history; two different accounts signed in sequentially on one browser (with sign-out between) never see each other's history.
