---
name: express-rate-limit IPv6 keyGenerator
description: express-rate-limit v8 rejects a custom keyGenerator that returns a raw IPv6 IP; use ipKeyGenerator.
---

# express-rate-limit custom keyGenerator + IPv6

A custom `keyGenerator: (req) => req.ip ?? "unknown"` triggers `ERR_ERL_KEY_GEN_IPV6`
under express-rate-limit v8. The library logs it (non-fatal) but the limiter is a
security control, so the warning must be resolved, not ignored.

**Rule:** wrap the client IP with the library's exported `ipKeyGenerator` helper
(`import { rateLimit, ipKeyGenerator } from "express-rate-limit"`), e.g.
`keyGenerator: (req) => ipKeyGenerator(req.ip ?? "unknown")`.

**Why:** raw IPv6 keys let one client rotate the low-order bits of its /64 to evade
the limit; `ipKeyGenerator` collapses IPv6 to its /64 subnet. This directly serves
the threat model's DoS guarantee for the paid-AI endpoints.

**How to apply:** any time you add a rate limiter with a custom `keyGenerator`,
use `ipKeyGenerator`, not `req.ip` directly.
