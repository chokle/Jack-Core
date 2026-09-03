import { pathToFileURL } from "node:url";

const DEFAULT_ZONE = "torchlabs.ca";
const DEFAULT_HOST = "jack.torchlabs.ca";
const DEFAULT_SCRIPT = "jack-core-production";

function required(value, label) {
  if (!value) throw new Error(`${label} is required`);
  return value;
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { success: response.ok, result: text };
  }
}

async function cfRequest(fetchImpl, token, path, options = {}) {
  const response = await fetchImpl(`https://api.cloudflare.com/client/v4${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const payload = await readJson(response);
  if (!response.ok || payload.success === false) {
    throw new Error(
      `${options.method ?? "GET"} ${path} failed: ${response.status} ${JSON.stringify(payload.errors ?? payload)}`,
    );
  }
  return payload.result;
}

function assertNoLegacyHeaders(response, label) {
  const legacy = [];
  for (const [name] of response.headers) {
    const normalized = name.toLowerCase();
    if (
      normalized.startsWith("x-railway-") ||
      normalized === "x-jack-edge-recovery"
    ) {
      legacy.push(normalized);
    }
  }
  if (legacy.length) {
    throw new Error(`${label} still exposes legacy routing headers: ${legacy.join(", ")}`);
  }
}

async function probeProduction(fetchImpl, host) {
  const nonce = Date.now();
  const options = {
    redirect: "follow",
    headers: { "Cache-Control": "no-cache" },
  };

  const root = await fetchImpl(`https://${host}/?route_handoff=${nonce}`, options);
  if (root.status !== 200) throw new Error(`production root returned ${root.status}`);
  assertNoLegacyHeaders(root, "production root");
  const csp = root.headers.get("content-security-policy") ?? "";
  if (!csp.includes("default-src 'self'") || !csp.includes("object-src 'none'")) {
    throw new Error("production root CSP is missing required baseline directives");
  }
  await root.text();

  const health = await fetchImpl(
    `https://${host}/api/healthz?route_handoff=${nonce}`,
    options,
  );
  if (health.status !== 200) throw new Error(`/api/healthz returned ${health.status}`);
  assertNoLegacyHeaders(health, "/api/healthz");
  const healthBody = await health.json();
  if (healthBody?.status !== "ok") throw new Error("/api/healthz did not report status=ok");

  const me = await fetchImpl(`https://${host}/api/me?route_handoff=${nonce}`, options);
  if (me.status !== 401) throw new Error(`anonymous /api/me returned ${me.status}, expected 401`);
  assertNoLegacyHeaders(me, "anonymous /api/me");
  const meBody = await me.json();
  if (!String(meBody?.error ?? "").includes("sign in required")) {
    throw new Error("anonymous /api/me did not fail closed with sign-in-required semantics");
  }
}

export async function runProductionRouteHandoff({
  fetchImpl = globalThis.fetch,
  token,
  zoneName = DEFAULT_ZONE,
  host = DEFAULT_HOST,
  desiredScript = DEFAULT_SCRIPT,
} = {}) {
  required(fetchImpl, "fetch implementation");
  required(token, "CLOUDFLARE_API_TOKEN");

  const zones = await cfRequest(
    fetchImpl,
    token,
    `/zones?name=${encodeURIComponent(zoneName)}&status=active&per_page=50`,
  );
  if (!Array.isArray(zones) || zones.length !== 1) {
    throw new Error(`Active ${zoneName} zone was not uniquely resolved`);
  }
  const zoneId = required(zones[0].id, "Cloudflare zone id");
  const pattern = `${host}/*`;
  const routesPath = `/zones/${zoneId}/workers/routes`;
  const routes = await cfRequest(fetchImpl, token, routesPath);
  const route = (routes ?? []).find((candidate) => candidate.pattern === pattern);
  if (!route?.id) throw new Error(`Existing production route ${pattern} was not found`);
  const previousScript = required(route.script, `Existing ${pattern} route owner`);
  let changed = false;

  if (previousScript !== desiredScript) {
    await cfRequest(fetchImpl, token, `${routesPath}/${route.id}`, {
      method: "PUT",
      body: JSON.stringify({ pattern, script: desiredScript }),
    });
    changed = true;
  }

  try {
    const afterRoutes = await cfRequest(fetchImpl, token, routesPath);
    const after = (afterRoutes ?? []).find((candidate) => candidate.id === route.id);
    if (after?.pattern !== pattern || after?.script !== desiredScript) {
      throw new Error(
        `Production route handoff did not converge to ${desiredScript}`,
      );
    }

    await probeProduction(fetchImpl, host);
    return {
      routeId: route.id,
      pattern,
      previousScript,
      currentScript: desiredScript,
      changed,
      verification: "PASS",
    };
  } catch (error) {
    if (changed) {
      await cfRequest(fetchImpl, token, `${routesPath}/${route.id}`, {
        method: "PUT",
        body: JSON.stringify({ pattern, script: previousScript }),
      });
    }
    throw new Error(
      `Production route handoff failed${changed ? `; restored ${previousScript}` : ""}: ${error.message}`,
      { cause: error },
    );
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  runProductionRouteHandoff({ token: process.env.CLOUDFLARE_API_TOKEN })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
