import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { clerkMiddleware } from "@clerk/express";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
} from "./middlewares/clerkProxyMiddleware";
import { requireAuth } from "./middlewares/requireAuth";
import router from "./routes";
import { logger } from "./lib/logger";
import { publish } from "./lib/vitality";

const app: Express = express();
const pilotAuthBypass = process.env["PILOT_AUTH_BYPASS"] === "true";

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://clerk.torchlabs.ca https://clerk.jack.torchlabs.ca https://clerk.staging.jack.torchlabs.ca https://*.clerk.accounts.dev https://*.clerk.com https://frontend-api.clerk.dev https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  "connect-src 'self' https://jack.torchlabs.ca https://*.supabase.co https://clerk.torchlabs.ca https://clerk.jack.torchlabs.ca https://clerk.staging.jack.torchlabs.ca https://*.clerk.accounts.dev https://*.clerk.com https://frontend-api.clerk.dev https://clerk-telemetry.com",
  "worker-src 'self' blob:",
  "frame-src 'self' https://challenges.cloudflare.com https://clerk.staging.jack.torchlabs.ca https://*.clerk.accounts.dev https://*.clerk.com",
  "object-src 'none'",
  "base-uri 'self'",
].join("; ");

app.use((_req, res, next) => {
  res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  next();
});

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// Clerk auth proxy — must run before the body parsers because it streams raw
// request bytes to Clerk's Frontend API. No-op in dev (the browser hits Clerk's
// dev FAPI directly); active in production where VITE_CLERK_PROXY_URL is set.
if (!pilotAuthBypass) app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

const allowedOrigins = (process.env["CORS_ALLOWED_ORIGINS"] || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Allow same-origin requests and non-browser clients that send no Origin header.
      if (!origin) return callback(null, true);
      if (allowedOrigins.length === 0) {
        // Without an explicit list, allow Torch subdomains and localhost development only.
        const allowed =
          /^https?:\/\/(.*\.)?torchlabs\.ca$/.test(origin) ||
          /^http:\/\/localhost(:\d+)?$/.test(origin);
        return callback(null, allowed);
      }
      return callback(null, allowedOrigins.includes(origin));
    },
    credentials: true,
  }),
);
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Populate Clerk auth state (reads the session cookie / Authorization header)
// so getAuth(req) works in the auth gate and route handlers. The publishable
// key is resolved from the request host to support multiple Clerk custom
// domains, falling back to CLERK_PUBLISHABLE_KEY.
if (!pilotAuthBypass) {
  app.use(clerkMiddleware({ publishableKey: process.env.CLERK_PUBLISHABLE_KEY }));
}

// Recovery for a browser holding a session for a Clerk user that was deleted.
// This must remain outside the /api auth gate because the stale token cannot
// authenticate. Clear both JS storage and HttpOnly cookies, then start fresh.
app.get("/api/auth/reset-session", (_req, res) => {
  const cookieNames = ["__session", "__client", "__client_uat", "__clerk_db_jwt"];
  for (const name of cookieNames) {
    res.clearCookie(name, { path: "/" });
    res.clearCookie(name, { path: "/", domain: ".torchlabs.ca" });
  }
  res.setHeader("Clear-Site-Data", '"cache", "cookies", "storage"');
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.redirect(302, `/sign-in?session_reset=${Date.now()}`);
});

// Server-enforced authentication boundary: every /api route except health
// probes requires a signed-in user. Runs before the vitality signal so
// unauthorized requests never register as load, and before the router so a
// direct-URL / incognito hit is rejected with 401 regardless of the frontend.
// Preserve a verified Clerk subject for ownership checks. This is the actual
// security boundary: the frontend sign-in wall is convenience only.
app.use("/api", requireAuth);

// Report meaningful (non-GET) API activity to the Vitality Engine so the
// heartbeat widget reflects real request load. GET/HEAD/OPTIONS (browsing,
// polling — including the widget's own poll — and CORS preflight) are excluded
// so idle traffic never registers as "busy".
app.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    return next();
  }
  publish({ type: "request:start" });
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    publish({ type: "request:end" });
  };
  res.on("finish", end);
  res.on("close", end);
  next();
});

app.use("/api", router);

const apiDir = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(apiDir, "../../jack-core/dist/public");
const frontendIndex = path.join(frontendDir, "index.html");

if (existsSync(frontendIndex)) {
  app.use((req, res, next) => {
    if (
      req.path === "/" ||
      req.path.endsWith(".html") ||
      req.path === "/sw.js" ||
      req.path === "/manifest.webmanifest"
    ) {
      res.setHeader("Cache-Control", "no-store, max-age=0");
    } else if (req.path.startsWith("/assets/")) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    }
    next();
  });
  app.use(express.static(frontendDir, { index: false }));
  app.get(/^(?!\/api(?:\/|$)).*/, (_req, res) => {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.sendFile(frontendIndex);
  });
} else if (process.env.NODE_ENV === "production") {
  logger.warn({ frontendDir }, "Frontend build not found; serving API only");
}

export default app;
