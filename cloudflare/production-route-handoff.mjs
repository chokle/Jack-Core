import { pathToFileURL } from "node:url";

const DEFAULT_ZONE = "torchlabs.ca";
const DEFAULT_HOST = "jack.torchlabs.ca";
const DEFAULT_SCRIPT = "jack-core-production";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

function required(value, label) {
  if (!value) throw new Error(`${label} is required`);
  return value;
}

async function fetchWithTimeout(
  fetchImpl,
  url,
  options = {},
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
) {
  const controller = new AbortController();
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error(`request timed out after ${timeoutMs}ms: ${url}`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      fetchImpl(url, { ...options, signal: controller.signal }),
      timeout,
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { success: response.ok, result: text };
  }
}

async function cfRequest(
  fetchImpl,
  token,
  path,
  options = {},
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
) {
  const response = await fetchWithTimeout(
    fetchImpl,
    `https://api.cloudflare.com/client/v4${path}`,
    {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(options.headers ?? {}),
      },
    },
    timeoutMs,
  );
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
    throw new Error(
      `${label} still exposes legacy routing headers: ${legacy.join(", ")}`,
    );
  }
}

async function probeProduction(
  fetchImpl,
  host,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
) {
  const nonce = Date.now();
  const options = {
    redirect: "manual",
    headers: { "Cache-Control": "no-cache" },
  };
  const request = (path) =>
    fetchWithTimeout(fetchImpl, `https://${host}${path}`, options, timeoutMs);

  const root = await request(`/?route_handoff=${nonce}`);
  if (root.status !== 200)
    throw new Error(`production root returned ${root.status}`);
  assertNoLegacyHeaders(root, "production root");
  const csp = root.headers.get("content-security-policy") ?? "";
  if (
    !csp.includes("default-src 'self'") ||
    !csp.includes("object-src 'none'")
  ) {
    throw new Error(
      "production root CSP is missing required baseline directives",
    );
  }
  await root.text();

  const health = await request(`/api/healthz?route_handoff=${nonce}`);
  if (health.status !== 200)
    throw new Error(`/api/healthz returned ${health.status}`);
  assertNoLegacyHeaders(health, "/api/healthz");
  const healthBody = await health.json();
  if (healthBody?.status !== "ok")
    throw new Error("/api/healthz did not report status=ok");

  const me = await request(`/api/me?route_handoff=${nonce}`);
  if (me.status !== 401)
    throw new Error(`anonymous /api/me returned ${me.status}, expected 401`);
  assertNoLegacyHeaders(me, "anonymous /api/me");
  const meBody = await me.json();
  if (!String(meBody?.error ?? "").includes("sign in required")) {
    throw new Error(
      "anonymous /api/me did not fail closed with sign-in-required semantics",
    );
  }
}

export async function runProductionRouteHandoff({
  fetchImpl = globalThis.fetch,
  token,
  zoneName = DEFAULT_ZONE,
  host = DEFAULT_HOST,
  desiredScript = DEFAULT_SCRIPT,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  required(fetchImpl, "fetch implementation");
  required(token, "CLOUDFLARE_API_TOKEN");

  const requestCloudflare = (path, options = {}) =>
    cfRequest(fetchImpl, token, path, options, requestTimeoutMs);

  const zones = await requestCloudflare(
    `/zones?name=${encodeURIComponent(zoneName)}&status=active&per_page=50`,
  );
  if (!Array.isArray(zones) || zones.length !== 1) {
    throw new Error(`Active ${zoneName} zone was not uniquely resolved`);
  }
  const zoneId = required(zones[0].id, "Cloudflare zone id");
  const pattern = `${host}/*`;
  const routesPath = `/zones/${zoneId}/workers/routes`;
  const routes = await requestCloudflare(routesPath);
  const route = (routes ?? []).find(
    (candidate) => candidate.pattern === pattern,
  );
  if (!route?.id)
    throw new Error(`Existing production route ${pattern} was not found`);
  const previousScript = required(
    route.script,
    `Existing ${pattern} route owner`,
  );
  let changed = false;
  let updateAttempted = false;

  try {
    if (previousScript !== desiredScript) {
      updateAttempted = true;
      await requestCloudflare(`${routesPath}/${route.id}`, {
        method: "PUT",
        body: JSON.stringify({ pattern, script: desiredScript }),
      });
      changed = true;
    }

    const afterRoutes = await requestCloudflare(routesPath);
    const after = (afterRoutes ?? []).find(
      (candidate) => candidate.id === route.id,
    );
    if (after?.pattern !== pattern || after?.script !== desiredScript) {
      throw new Error(
        `Production route handoff did not converge to ${desiredScript}`,
      );
    }

    await probeProduction(fetchImpl, host, requestTimeoutMs);
    return {
      routeId: route.id,
      pattern,
      previousScript,
      currentScript: desiredScript,
      changed,
      verification: "PASS",
    };
  } catch (error) {
    let restored = false;
    if (updateAttempted) {
      try {
        const recoveryRoutes = await requestCloudflare(routesPath);
        const current = (recoveryRoutes ?? []).find(
          (candidate) => candidate.id === route.id,
        );
        if (!current) {
          throw new Error(
            `Production route ${route.id} disappeared during recovery`,
          );
        }

        if (current.script === desiredScript) {
          await requestCloudflare(`${routesPath}/${route.id}`, {
            method: "PUT",
            body: JSON.stringify({ pattern, script: previousScript }),
          });
          const restoredRoutes = await requestCloudflare(routesPath);
          const restoredRoute = (restoredRoutes ?? []).find(
            (candidate) => candidate.id === route.id,
          );
          if (
            restoredRoute?.pattern !== pattern ||
            restoredRoute?.script !== previousScript
          ) {
            throw new Error(
              `Rollback did not converge to ${previousScript}; current owner is ${restoredRoute?.script ?? "unknown"}`,
            );
          }
          restored = true;
        } else if (current.script === previousScript) {
          restored = true;
        } else {
          throw new Error(
            `Rollback refused: production route is now owned by ${current.script}`,
          );
        }
      } catch (recoveryError) {
        throw new Error(
          `Production route handoff failed; rollback not confirmed: ${recoveryError.message}; original error: ${error.message}`,
          { cause: error },
        );
      }
    }

    throw new Error(
      `Production route handoff failed${restored ? `; restored ${previousScript}` : ""}: ${error.message}`,
      { cause: error },
    );
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : null;
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
