---
name: Jack SEO canonical & brand origins
description: How Jack's public metadata models the Torch brand vs the product app, and why the canonical origin is pinned rather than derived.
---

# Jack SEO canonical & brand origins

- The public site URL used for canonical, Open Graph, Twitter, sitemap, robots, and the WebSite/SoftwareApplication JSON-LD nodes is **pinned to the production origin `https://app.torchlabs.ca`** (via `resolveSiteUrl()` in `artifacts/jack-core/vite.config.ts`, overridable with `PUBLIC_SITE_URL`). It is intentionally NOT derived from `REPLIT_DOMAINS` / the serving domain.
  **Why:** Jack renders in several environments (Replit preview, `*.replit.app`, the live custom domain). A self-referential per-environment canonical would let the preview/.replit.app copy get indexed as authoritative. Pinning a cross-domain canonical to the real production home is the correct SEO technique; claiming it before DNS resolves is fine — crawlers defer until reachable.
  **How to apply:** Don't "fix" this back to serving-domain derivation. If the app moves, set `PUBLIC_SITE_URL` or change the default.

- **Two-origin brand model in the JSON-LD @graph:** the `Organization` (parent brand "Torch") is `https://www.torchlabs.ca` — the marketing site. Note `torchlabs.ca` 301-redirects to `www`, so use `www` exactly in the `@id`/`url` for entity reconciliation. The product `WebSite` + `SoftwareApplication` (Jack) live on `https://app.torchlabs.ca` and credit the org via `publisher`/`creator` `@id`.

- **apple-touch-icon must be a raster PNG (180×180), not SVG** — iOS/Safari ignores SVG apple-touch-icons and falls back to a page snapshot. (An SVG `favicon.svg` is fine for modern desktop browsers.) The Torch mark is a navy `#1a2332` square with an orange `#ff6b35` "T".
