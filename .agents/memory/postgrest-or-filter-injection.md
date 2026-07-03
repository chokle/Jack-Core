---
name: PostgREST .or() filter injection via client-controlled values
description: Inlining a cookie/header/query value into a supabase-js .or() filter string is a filter-injection risk; validate before use.
---

`.or("a.eq.1,b.eq.VALUE")` in supabase-js builds a raw PostgREST filter string. Unlike `.eq()`, where the value is passed as a single bound parameter, `.or()` splits on commas — so any client-controlled `VALUE` containing a comma can inject extra disjuncts and widen the query (e.g. an HttpOnly session cookie is not JS-readable by the page, but a raw HTTP client can still set an arbitrary `Cookie` header).

**Why:** found live in a "list my own rows OR public rows" endpoint that inlined a session-cookie value into `.or()`, assuming "it's always a server-minted UUID" — that assumption isn't enforced by anything at the HTTP boundary, so a crafted cookie leaked rows across sessions.

**How to apply:** before inlining any externally-supplied value (cookie, header, query param) into `.or()`, validate its shape (e.g. UUID regex) and fall back to the safe/narrow branch if it fails validation. Prefer `.eq()`/`.in()` wherever possible since those bind values safely; reserve `.or()` for combining server-controlled literals.
