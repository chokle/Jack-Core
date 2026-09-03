import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runProductionRouteHandoff } from "./production-route-handoff.mjs";

function jsonResponse(result, init = {}) {
  return new Response(JSON.stringify({ success: true, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function appResponse(body, status = 200, headers = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: {
      "content-type":
        typeof body === "string" ? "text/html" : "application/json",
      ...headers,
    },
  });
}

function harness({
  failHealth = false,
  legacyHeader = false,
  redirectRoot = false,
  rejectMutatingPut = false,
  rollbackFails = false,
  stallHealth = false,
  stallRouteReadAfterHandoff = false,
} = {}) {
  let routeScript = "jack-production-csp-stable-20260828";
  const mutations = [];
  let routeReadsAfterHandoff = 0;

  const fetchImpl = async (url, options = {}) => {
    const target = new URL(url);
    if (target.hostname === "api.cloudflare.com") {
      if (target.pathname === "/client/v4/zones") {
        return jsonResponse([{ id: "zone-1", name: "torchlabs.ca" }]);
      }
      if (target.pathname === "/client/v4/zones/zone-1/workers/routes") {
        if (routeScript === "jack-core-production") {
          routeReadsAfterHandoff += 1;
          if (stallRouteReadAfterHandoff && routeReadsAfterHandoff === 1) {
            return new Promise(() => {});
          }
        }
        return jsonResponse([
          {
            id: "route-1",
            pattern: "jack.torchlabs.ca/*",
            script: routeScript,
          },
        ]);
      }
      if (
        target.pathname === "/client/v4/zones/zone-1/workers/routes/route-1"
      ) {
        assert.equal(options.method, "PUT");
        const body = JSON.parse(options.body);
        mutations.push(body.script);
        if (
          body.script === "jack-production-csp-stable-20260828" &&
          rollbackFails
        ) {
          return jsonResponse({ id: "route-1", ...body });
        }
        routeScript = body.script;
        if (body.script === "jack-core-production" && rejectMutatingPut) {
          return jsonResponse({ id: "route-1", ...body }, { status: 500 });
        }
        return jsonResponse({ id: "route-1", ...body });
      }
      throw new Error(`unexpected Cloudflare URL ${url}`);
    }

    assert.equal(target.hostname, "jack.torchlabs.ca");
    const edgeHeaders = legacyHeader
      ? { "x-jack-edge-recovery": "legacy" }
      : {};
    if (target.pathname === "/") {
      if (redirectRoot) {
        assert.equal(options.redirect, "manual");
        return appResponse("", 302, { location: "https://example.com/" });
      }
      return appResponse("<html>Jack</html>", 200, {
        "content-security-policy": "default-src 'self'; object-src 'none'",
        ...edgeHeaders,
      });
    }
    if (target.pathname === "/api/healthz") {
      if (stallHealth) return new Promise(() => {});
      return appResponse(
        failHealth ? { status: "bad" } : { status: "ok" },
        failHealth ? 500 : 200,
        edgeHeaders,
      );
    }
    if (target.pathname === "/api/me") {
      return appResponse({ error: "sign in required" }, 401, edgeHeaders);
    }
    throw new Error(`unexpected production URL ${url}`);
  };

  return {
    fetchImpl,
    get routeScript() {
      return routeScript;
    },
    mutations,
  };
}

test("wrangler deploy stays on workers.dev until the accepted route handoff", async () => {
  const base = JSON.parse(
    await readFile(new URL("./wrangler.base.json", import.meta.url), "utf8"),
  );
  assert.equal(base.name, "jack-core-production");
  assert.equal(base.workers_dev, true);
  assert.equal(base.routes, undefined);
});

test("hands the existing production route to jack-core only after direct verification", async () => {
  const state = harness();
  const result = await runProductionRouteHandoff({
    fetchImpl: state.fetchImpl,
    token: "test-token",
  });

  assert.equal(state.routeScript, "jack-core-production");
  assert.deepEqual(state.mutations, ["jack-core-production"]);
  assert.deepEqual(result, {
    routeId: "route-1",
    pattern: "jack.torchlabs.ca/*",
    previousScript: "jack-production-csp-stable-20260828",
    currentScript: "jack-core-production",
    changed: true,
    verification: "PASS",
  });
});

test("restores the previous route owner when production verification fails", async () => {
  const state = harness({ failHealth: true });

  await assert.rejects(
    runProductionRouteHandoff({
      fetchImpl: state.fetchImpl,
      token: "test-token",
    }),
    /restored jack-production-csp-stable-20260828/,
  );

  assert.equal(state.routeScript, "jack-production-csp-stable-20260828");
  assert.deepEqual(state.mutations, [
    "jack-core-production",
    "jack-production-csp-stable-20260828",
  ]);
});

test("rejects legacy edge or Railway routing evidence and rolls back", async () => {
  const state = harness({ legacyHeader: true });

  await assert.rejects(
    runProductionRouteHandoff({
      fetchImpl: state.fetchImpl,
      token: "test-token",
    }),
    /legacy routing headers/,
  );

  assert.equal(state.routeScript, "jack-production-csp-stable-20260828");
});

test("rejects redirects during custom-domain verification and rolls back", async () => {
  const state = harness({ redirectRoot: true });

  await assert.rejects(
    runProductionRouteHandoff({
      fetchImpl: state.fetchImpl,
      token: "test-token",
    }),
    /production root returned 302/,
  );

  assert.equal(state.routeScript, "jack-production-csp-stable-20260828");
});

test("recovers when the route PUT mutates state before returning an error", async () => {
  const state = harness({ rejectMutatingPut: true });

  await assert.rejects(
    runProductionRouteHandoff({
      fetchImpl: state.fetchImpl,
      token: "test-token",
    }),
    /restored jack-production-csp-stable-20260828/,
  );

  assert.equal(state.routeScript, "jack-production-csp-stable-20260828");
  assert.deepEqual(state.mutations, [
    "jack-core-production",
    "jack-production-csp-stable-20260828",
  ]);
});

test("does not claim restoration when rollback fails to converge", async () => {
  const state = harness({ failHealth: true, rollbackFails: true });

  await assert.rejects(
    runProductionRouteHandoff({
      fetchImpl: state.fetchImpl,
      token: "test-token",
    }),
    /rollback not confirmed: Rollback did not converge/,
  );

  assert.equal(state.routeScript, "jack-core-production");
});

test("times out a stalled production probe and rolls back", async () => {
  const state = harness({ stallHealth: true });

  await assert.rejects(
    runProductionRouteHandoff({
      fetchImpl: state.fetchImpl,
      token: "test-token",
      requestTimeoutMs: 10,
    }),
    /request timed out.*restored|restored.*request timed out/,
  );

  assert.equal(state.routeScript, "jack-production-csp-stable-20260828");
});

test("times out a stalled post-update Cloudflare read and rolls back", async () => {
  const state = harness({ stallRouteReadAfterHandoff: true });

  await assert.rejects(
    runProductionRouteHandoff({
      fetchImpl: state.fetchImpl,
      token: "test-token",
      requestTimeoutMs: 10,
    }),
    /restored jack-production-csp-stable-20260828.*request timed out/,
  );

  assert.equal(state.routeScript, "jack-production-csp-stable-20260828");
});
