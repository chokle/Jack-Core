import { Container, getContainer } from "@cloudflare/containers";
import { limitedBytes, validateDepthPly } from "./radar-ply.mjs";

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
  "RADAR_WORKER_TOKEN",
  "DAZ_RUNTIME_URL",
  "DAZ_RUNTIME_TOKEN",
  "RESEND_API_KEY",
  "FEEDBACK_FROM_EMAIL",
  "FEEDBACK_NOTIFICATION_RECIPIENTS",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_DB_URL",
  "OPENAI_API_KEY",
  "HYDRA_DB_ENABLED",
  "HYDRA_DB_API_KEY",
  "HYDRA_DB_TENANT_ID",
  "HYDRA_DB_TIMEOUT_MS",
  "ELEVENLABS_API_KEY",
  "JACK_VOICE_ID",
  "PILOT_001_ID",
  "PILOT_001_ORGANIZATION_ID",
  "PILOT_AUTH_BYPASS",
  "PILOT_AUTH_USER_ID",
  "PILOT_AUTH_EMAIL",
  "PILOT_AUTH_NAME",
  "PILOT_AUTH_ADMIN",
  "PILOT_DIRECT_ACCESS_EMAILS",
  "PILOT_DIRECT_ACCESS_REDIRECT",
];

function containerEnv(env) {
  const resolved = {
    NODE_ENV: "production",
    PORT: String(CONTAINER_PORT),
    BASE_PATH: "/",
    PUBLIC_SITE_URL: "https://jack.torchlabs.ca",
    CORS_ALLOWED_ORIGINS: "https://jack.torchlabs.ca,https://app.torchlabs.ca",
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

const UPLOAD_PATH =
  /^\/api\/site-mapping\/sites\/([0-9a-f-]{36})\/scans\/upload$/i;
const DOWNLOAD_PATH =
  /^\/api\/site-mapping\/sites\/([0-9a-f-]{36})\/scans\/([0-9a-f-]{36})\/download$/i;

async function internalRequest(container, original, env, path, method, body) {
  const headers = new Headers();
  for (const name of ["cookie", "authorization", "origin"]) {
    const value = original.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("x-jack-radar-worker-token", env.RADAR_WORKER_TOKEN);
  if (body) headers.set("content-type", "application/json");
  return container.fetch(
    new Request(new URL(path, original.url), {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
}

async function uploadScan(request, env, container, siteId) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin)
    return Response.json(
      { error: "Cross-site scan upload denied." },
      { status: 403 },
    );
  if (!env.RADAR_SCANS || !env.RADAR_WORKER_TOKEN)
    return Response.json(
      { error: "Site scan storage is unavailable." },
      { status: 503 },
    );
  if (
    request.headers.get("content-type")?.split(";")[0] !==
    "application/octet-stream"
  )
    return Response.json(
      { error: "Upload a Radar depth PLY file." },
      { status: 415 },
    );
  const access = await internalRequest(
    container,
    request,
    env,
    `/api/site-mapping/sites/${siteId}/upload-access`,
    "GET",
  );
  if (!access.ok) return access;
  let bytes;
  let pointCount;
  try {
    bytes = await limitedBytes(request);
    pointCount = validateDepthPly(bytes);
  } catch (err) {
    const status = err instanceof RangeError ? 413 : 400;
    return Response.json(
      { error: err instanceof Error ? err.message : "Invalid scan." },
      { status },
    );
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const sha256 = [...digest]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  const authorize = await internalRequest(
    container,
    request,
    env,
    `/api/site-mapping/internal/sites/${siteId}/scans/authorize`,
    "POST",
    { byteSize: bytes.byteLength, pointCount, sha256 },
  );
  if (!authorize.ok) return authorize;
  const { scanId, objectKey } = await authorize.json();
  try {
    await env.RADAR_SCANS.put(objectKey, bytes, {
      httpMetadata: { contentType: "application/octet-stream" },
    });
  } catch {
    return Response.json(
      { error: "Scan storage failed. Please retry." },
      { status: 502 },
    );
  }
  // Completion is idempotent. A timeout may mean the API committed successfully,
  // so retain R2 bytes if both attempts are inconclusive; never strand metadata
  // that says uploaded by deleting its underlying object.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const complete = await internalRequest(
        container,
        request,
        env,
        `/api/site-mapping/internal/sites/${siteId}/scans/${scanId}/complete`,
        "POST",
      );
      if (complete.ok)
        return Response.json(
          {
            scanId,
            pointCount,
            byteSize: bytes.byteLength,
            status: "uploaded",
          },
          { status: 201 },
        );
    } catch {
      /* The first completion may have succeeded; retry the same scan ID. */
    }
  }
  return Response.json(
    {
      error:
        "Scan confirmation is pending. Check the site capture list before uploading again.",
    },
    { status: 502 },
  );
}

async function downloadScan(request, env, container, siteId, scanId) {
  if (!env.RADAR_SCANS || !env.RADAR_WORKER_TOKEN)
    return Response.json(
      { error: "Site scan storage is unavailable." },
      { status: 503 },
    );
  const authorized = await internalRequest(
    container,
    request,
    env,
    `/api/site-mapping/internal/sites/${siteId}/scans/${scanId}/download`,
    "GET",
  );
  if (!authorized.ok) return authorized;
  const { objectKey } = await authorized.json();
  const object = await env.RADAR_SCANS.get(objectKey);
  if (!object)
    return Response.json(
      { error: "Scan file is unavailable." },
      { status: 404 },
    );
  return new Response(object.body, {
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="radar-scan-${scanId}.ply"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function deleteAccountScan(request, env) {
  const token = env.RADAR_WORKER_TOKEN;
  if (!env.RADAR_SCANS || typeof token !== "string" || token.length < 32)
    return Response.json(
      { error: "Site scan storage is unavailable." },
      { status: 503 },
    );
  if (request.headers.get("x-jack-radar-worker-token") !== token)
    return Response.json({ error: "Forbidden." }, { status: 403 });
  const body = await request.json().catch(() => null);
  const objectKey = body?.objectKey;
  if (
    typeof objectKey !== "string" ||
    !/^organizations\/[0-9a-f-]{36}\/sites\/[0-9a-f-]{36}\/scans\/[0-9a-f-]{36}\.ply$/i.test(
      objectKey,
    )
  )
    return Response.json({ error: "Invalid scan object." }, { status: 400 });
  await env.RADAR_SCANS.delete(objectKey);
  return new Response(null, { status: 204 });
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (
      request.method === "POST" &&
      path === "/api/site-mapping/internal/objects/delete"
    )
      return deleteAccountScan(request, env);
    const container = getContainer(env.JACK_CONTAINER, CONTAINER_NAME);
    const upload = request.method === "POST" ? path.match(UPLOAD_PATH) : null;
    if (upload) return uploadScan(request, env, container, upload[1]);
    const download =
      request.method === "GET" ? path.match(DOWNLOAD_PATH) : null;
    if (download)
      return downloadScan(request, env, container, download[1], download[2]);
    return container.fetch(request);
  },
  async scheduled(_controller, env) {
    if (!env.RADAR_SCANS || !env.RADAR_WORKER_TOKEN)
      throw new Error("Radar cleanup storage is unavailable");
    const container = getContainer(env.JACK_CONTAINER, CONTAINER_NAME);
    const original = new Request(
      env.PUBLIC_SITE_URL || "https://jack.torchlabs.ca/",
    );
    for (let batch = 0; batch < 10; batch++) {
      const claimed = await internalRequest(
        container,
        original,
        env,
        "/api/site-mapping/internal/scans/cleanup/claim",
        "POST",
      );
      if (!claimed.ok) throw new Error("Radar cleanup claim failed");
      const { scans } = await claimed.json();
      if (!Array.isArray(scans) || scans.length === 0) return;
      for (const scan of scans) {
        await env.RADAR_SCANS.delete(scan.objectKey);
        const removed = await internalRequest(
          container,
          original,
          env,
          `/api/site-mapping/internal/scans/${scan.id}/cleanup`,
          "DELETE",
        );
        if (!removed.ok)
          throw new Error("Radar cleanup metadata removal failed");
      }
      if (scans.length < 100) return;
    }
  },
};
