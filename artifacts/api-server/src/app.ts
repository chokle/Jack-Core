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
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Populate Clerk auth state (reads the session cookie / Authorization header)
// so getAuth(req) works in the auth gate and route handlers. The publishable
// key is resolved from the request host to support multiple Clerk custom
// domains, falling back to CLERK_PUBLISHABLE_KEY.
app.use(clerkMiddleware({ publishableKey: process.env.CLERK_PUBLISHABLE_KEY }));

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
// Explicitly authorized public presentation mode. Scope all non-admin demo
// activity to one stable identity; requireAdmin still protects admin writes.
app.use("/api", (req, _res, next) => {
  req.userId = "presentation-demo";
  next();
});

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
  app.use(express.static(frontendDir, { index: false }));
  app.get(/^(?!\/api(?:\/|$)).*/, (_req, res) => {
    res.sendFile(frontendIndex);
  });
} else if (process.env.NODE_ENV === "production") {
  logger.warn({ frontendDir }, "Frontend build not found; serving API only");
}

export default app;
