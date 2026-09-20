import { test } from "node:test";
import assert from "node:assert/strict";
import { registerClerkProxy } from "./register-clerk-proxy.mjs";

const expected = "https://jack.torchlabs.ca/api/__clerk";
function fixture(status, body, previous = null) {
  const calls = [];
  let registered = previous;
  const fetcher = async (url, options) => {
    calls.push({ url, method: options.method ?? "GET" });
    if (url.startsWith(expected)) return Response.json(body, { status });
    if (options.method === "PATCH") {
      registered = JSON.parse(options.body).proxy_url;
      return Response.json({});
    }
    return Response.json({
      data: [
        {
          id: "domain_fixture",
          name: "torchlabs.ca",
          is_satellite: false,
          proxy_url: registered,
        },
      ],
    });
  };
  return { calls, fetcher };
}
test("registers a reachable unregistered Clerk proxy and reads it back", async () => {
  const f = fixture(400, {
    clerk_trace_id: "trace",
    errors: [{ code: "host_invalid" }],
  });
  await registerClerkProxy("sk_live_fixture", f.fetcher);
  assert.equal(f.calls.filter((c) => c.method === "PATCH").length, 1);
  assert.equal(f.calls.at(-1).method, "GET");
});
test("does not mutate on Cloudflare or unrelated Clerk failure", async () => {
  for (const [status, body] of [
    [403, {}],
    [400, { clerk_trace_id: "trace", errors: [{ code: "other" }] }],
  ]) {
    const f = fixture(status, body);
    await assert.rejects(
      registerClerkProxy("sk_live_fixture", f.fetcher),
      /not ready/,
    );
    assert.ok(f.calls.every((c) => c.method !== "PATCH"));
  }
});
test("preserves a different configured proxy", async () => {
  const f = fixture(200, {}, "https://another.example/proxy");
  await assert.rejects(
    registerClerkProxy("sk_live_fixture", f.fetcher),
    /Unexpected existing/,
  );
  assert.equal(f.calls.length, 1);
});
test("already registered state does not repeat the write", async () => {
  const f = fixture(200, {}, expected);
  await registerClerkProxy("sk_live_fixture", f.fetcher);
  assert.ok(f.calls.every((c) => c.method !== "PATCH"));
});
