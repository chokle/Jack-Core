---
name: Clerk CSP allowlist
description: A strict index.html meta CSP silently blocks Clerk JS from loading; whitelist Clerk origins or the whole app fails to render.
---

Rule: jack-core pins a strict `<meta http-equiv="Content-Security-Policy">` in `artifacts/jack-core/index.html`. Adding Clerk (or any third-party SDK/script) requires extending that CSP in lockstep, or the external script is blocked and the app never renders.

Needed directives for Clerk (dev):
- `script-src`, `connect-src`, `frame-src` → add `https://*.clerk.accounts.dev`
- `script-src`, `frame-src` → add `https://challenges.cloudflare.com` (Cloudflare Turnstile bot check)
- `connect-src` → add `https://clerk-telemetry.com`
- add `worker-src 'self' blob:` (Clerk uses blob web workers)
- `img-src https:` already covers Clerk avatars (img.clerk.com)

Prod: Clerk runs through a same-origin proxy (`VITE_CLERK_PROXY_URL` → `/api/__clerk`), so the FAPI calls and `clerk.browser.js` are same-origin and already covered by `'self'`. No extra prod-only CSP entries are needed beyond the dev ones above.

**Why:** The symptom looks like a network failure — browser throws `Clerk: Failed to load Clerk JS, failed to load script: https://<slug>.clerk.accounts.dev/...` — but the domain is reachable (curl returns 307 for the versioned asset and 200 for `/v1/environment`). The real cause is the CSP rejecting the external script; the giveaway is the console line `Refused to load the script ... because it violates ... Content Security Policy directive: "script-src 'self' 'unsafe-inline'"`. Diagnose CSP before chasing network/DNS.

**How to apply:** Whenever you add a third-party script/SDK to a jack-core-style app that ships a hardcoded meta CSP, update `index.html`'s CSP at the same time, and check the browser console for `Refused to load ... Content Security Policy` first when an external script "fails to load".
