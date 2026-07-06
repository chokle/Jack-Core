import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

// Absolute canonical origin of the deployed app, used to make canonical/OG/
// structured-data URLs and the sitemap/robots entries absolute.
function resolveSiteUrl(): string {
  // Jack ships as the Torch product app at app.torchlabs.ca, so canonical/OG/
  // sitemap URLs must point there regardless of which environment renders the
  // page (preview, .replit.app, or the live custom domain). Override with
  // PUBLIC_SITE_URL if the app ever moves.
  const raw = process.env.PUBLIC_SITE_URL?.trim() || "https://app.torchlabs.ca";
  const host = raw.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return host ? `https://${host}` : "";
}

// Injects the absolute site URL into index.html (via the `__SITE_URL__` token)
// and generates SEO/AI-crawler assets (robots.txt + sitemap.xml) with absolute
// URLs, served in dev and emitted at build.
function seoAssetsPlugin(): Plugin {
  const siteUrl = resolveSiteUrl();

  const robotsTxt = `# Torch — Jack: AI Trade Intelligence Engine
User-agent: *
Allow: /

# Explicitly welcome major AI + search crawlers
User-agent: GPTBot
Allow: /

User-agent: OAI-SearchBot
Allow: /

User-agent: ChatGPT-User
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: Claude-Web
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Google-Extended
Allow: /

User-agent: Applebot-Extended
Allow: /

User-agent: CCBot
Allow: /

Sitemap: ${siteUrl}/sitemap.xml
`;

  const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${siteUrl}/</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
`;

  return {
    name: "torch-seo-assets",
    transformIndexHtml(html) {
      return html.replaceAll("__SITE_URL__", siteUrl);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split("?")[0];
        if (url === "/robots.txt") {
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end(robotsTxt);
          return;
        }
        if (url === "/sitemap.xml") {
          res.setHeader("Content-Type", "application/xml; charset=utf-8");
          res.end(sitemapXml);
          return;
        }
        next();
      });
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "robots.txt",
        source: robotsTxt,
      });
      this.emitFile({
        type: "asset",
        fileName: "sitemap.xml",
        source: sitemapXml,
      });
    },
  };
}

const rawPort = process.env.PORT;

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH;

if (!basePath) {
  throw new Error(
    "BASE_PATH environment variable is required but was not provided.",
  );
}

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    // optimize:false keeps lightningcss from reordering the @layer imports that
    // Clerk's themes rely on — without it the Clerk UI renders broken in prod.
    tailwindcss({ optimize: false }),
    runtimeErrorOverlay(),
    seoAssetsPlugin(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
