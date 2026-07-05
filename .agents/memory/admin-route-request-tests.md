---
name: Admin-gated route request tests
description: How to write request-level (supertest) tests for routes behind requireAdminSession in api-server.
---

Request-level tests for admin-gated Express routes (e.g. PATCH /graph/nodes/:id/verification) in `artifacts/api-server`:

- `admin-auth.ts` reads `JACK_ADMIN_KEY` **at module-load time** (top-level const). Set it in `vi.hoisted(() => { process.env.JACK_ADMIN_KEY = ... })` so it lands before the static import graph resolves. A plain top-level assignment runs after ESM imports (hoisted) and is too late.
- Mint a valid signed session cookie by calling the real `createAdminSession(key, fakeRes)` with a fake `Response` whose `.cookie(name, value)` captures `${name}=${value}`. Don't reimplement HMAC signing.
- Mock the Supabase-backed lib (`../../lib/memory-graph.js`) with `vi.hoisted(() => vi.fn())` + `vi.mock` so the route never touches a real DB — the test asserts the authorization boundary, not the graph write.
- The minimal test app needs `cookieParser()` + `express.json()` **and** a middleware setting `req.log = {warn,error,info,debug: noop}` — route handlers/`requireAdminSession` call `req.log.*` (normally wired by pino-http).
- `supertest` + `@types/supertest` are devDeps of api-server for this.

**Why:** the API uses the Supabase service-role key with no other auth boundary; the requireAdminSession middleware is the only thing stopping anonymous callers from rewriting trusted state, so it deserves request-level coverage, not just lib unit tests.
