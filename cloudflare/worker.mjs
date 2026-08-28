import { DurableObject } from "cloudflare:workers";

const CONTAINER_PORT = 8080;
const CONTAINER_NAME = "jack-production";
const STARTUP_RETRIES = 40;
const STARTUP_RETRY_MS = 250;

const RUNTIME_ENV_KEYS = [
  "NODE_ENV",
  "PORT",
  "BASE_PATH",
  "PUBLIC_SITE_URL",
  "CORS_ALLOWED_ORIGINS",
  "CLERK_PUBLISHABLE_KEY",
  "CLERK_SECRET_KEY",
  "ADMIN_EMAILS",
  "RESEND_API_KEY",
  "FEEDBACK_FROM_EMAIL",
  "FEEDBACK_NOTIFICATION_RECIPIENTS",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_DB_URL",
  "OPENAI_API_KEY",
  "PILOT_001_ID",
  "PILOT_001_ORGANIZATION_ID",
  "PILOT_AUTH_BYPASS",
  "PILOT_AUTH_USER_ID",
  "PILOT_AUTH_EMAIL",
  "PILOT_AUTH_NAME",
  "PILOT_AUTH_ADMIN",
];

function containerEnv(env) {
  const resolved = {
    NODE_ENV: "production",
    PORT: String(CONTAINER_PORT),
    BASE_PATH: "/",
    PUBLIC_SITE_URL: "https://jack.torchlabs.ca",
    CORS_ALLOWED_ORIGINS: "https://jack.torchlabs.ca",
  };

  for (const key of RUNTIME_ENV_KEYS) {
    const value = env[key];
    if (typeof value === "string" && value.length > 0) {
      resolved[key] = value;
    }
  }

  return resolved;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function containerRequest(request) {
  const url = new URL(request.url);
  const target = `http://container${url.pathname}${url.search}`;
  return new Request(target, request);
}

export class JackProductionContainer extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.runtimeEnv = containerEnv(env);
  }

  startIfNeeded() {
    if (this.ctx.container.running) return;

    this.ctx.container.start({
      env: this.runtimeEnv,
      enableInternet: true,
      entrypoint: [
        "node",
        "--enable-source-maps",
        "./artifacts/api-server/dist/index.mjs",
      ],
    });
  }

  async fetch(request) {
    this.startIfNeeded();
    const port = this.ctx.container.getTcpPort(CONTAINER_PORT);
    let lastError;

    for (let attempt = 0; attempt < STARTUP_RETRIES; attempt += 1) {
      try {
        return await port.fetch(containerRequest(request));
      } catch (error) {
        lastError = error;
        if (!this.ctx.container.running) this.startIfNeeded();
        await sleep(STARTUP_RETRY_MS);
      }
    }

    console.error("Jack production container failed readiness", lastError);
    return new Response("Jack production container unavailable", {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  }
}

export default {
  async fetch(request, env) {
    const instance = env.JACK_CONTAINER.getByName(CONTAINER_NAME);
    return instance.fetch(request);
  },
};
