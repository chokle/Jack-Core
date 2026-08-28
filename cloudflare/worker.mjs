import { Container, getContainer } from "@cloudflare/containers";

const CONTAINER_PORT = 8080;
const CONTAINER_NAME = "jack-production";

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

/**
 * Cloudflare's supported Container lifecycle helper owns startup, port
 * readiness, request forwarding and idle shutdown. This replaces the previous
 * manual low-level Durable Object loop, which could observe a running instance
 * before port 8080 was actually ready and leave workers.dev requests hanging.
 */
export class JackProductionContainer extends Container {
  defaultPort = CONTAINER_PORT;
  requiredPorts = [CONTAINER_PORT];
  sleepAfter = "10m";
  entrypoint = [
    "node",
    "--enable-source-maps",
    "./artifacts/api-server/dist/index.mjs",
  ];
  enableInternet = true;
  pingEndpoint = "localhost/api/healthz";

  constructor(ctx, env) {
    super(ctx, env);
    this.envVars = containerEnv(env);
  }
}

export default {
  async fetch(request, env) {
    return getContainer(env.JACK_CONTAINER, CONTAINER_NAME).fetch(request);
  },
};
