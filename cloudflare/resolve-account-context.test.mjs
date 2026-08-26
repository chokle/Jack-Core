import assert from "node:assert/strict";
import test from "node:test";

import { resolveCloudflareAccountId } from "./resolve-account-context.mjs";

function response(result, { status = 200, success = true, errors = [] } = {}) {
  return new Response(JSON.stringify({ success, result, errors }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("uses explicit account override without calling Cloudflare", async () => {
  let called = false;
  const resolved = await resolveCloudflareAccountId({
    token: "token",
    configuredAccountId: "acct-explicit",
    fetchImpl: async () => {
      called = true;
      throw new Error("unexpected fetch");
    },
  });

  assert.deepEqual(resolved, {
    accountId: "acct-explicit",
    source: "optional repository override",
  });
  assert.equal(called, false);
});

test("resolves the account from torchlabs.ca zone ownership", async () => {
  const resolved = await resolveCloudflareAccountId({
    token: "token",
    fetchImpl: async (url) => {
      assert.match(url, /\/zones\?name=torchlabs\.ca/);
      return response([
        {
          name: "torchlabs.ca",
          account: { id: "acct-zone", name: "Torch Labs" },
        },
      ]);
    },
  });

  assert.deepEqual(resolved, {
    accountId: "acct-zone",
    source: "torchlabs.ca zone ownership",
  });
});

test("falls back to a single token-visible account when zone lookup is unavailable", async () => {
  const resolved = await resolveCloudflareAccountId({
    token: "token",
    fetchImpl: async (url) => {
      if (url.includes("/zones?")) {
        return response([], {
          status: 403,
          success: false,
          errors: [{ message: "zone read denied" }],
        });
      }
      assert.match(url, /\/accounts\?per_page=50$/);
      return response([{ id: "acct-only", name: "Only Account" }]);
    },
  });

  assert.deepEqual(resolved, {
    accountId: "acct-only",
    source: "single token-visible account",
  });
});

test("prefers one Torch-named account when several accounts are visible", async () => {
  const resolved = await resolveCloudflareAccountId({
    token: "token",
    fetchImpl: async (url) => {
      if (url.includes("/zones?")) return response([]);
      return response([
        { id: "acct-other", name: "Other Company" },
        { id: "acct-torch", name: "Torch Labs" },
      ]);
    },
  });

  assert.deepEqual(resolved, {
    accountId: "acct-torch",
    source: "unique Torch-named account",
  });
});

test("fails closed when account scope is ambiguous", async () => {
  await assert.rejects(
    resolveCloudflareAccountId({
      token: "token",
      fetchImpl: async (url) => {
        if (url.includes("/zones?")) return response([]);
        return response([
          { id: "acct-one", name: "Company One" },
          { id: "acct-two", name: "Company Two" },
        ]);
      },
    }),
    /Unable to resolve a single Torch Cloudflare account from token scope \(2 accounts visible\)/,
  );
});

test("fails closed when the API token is absent", async () => {
  await assert.rejects(
    resolveCloudflareAccountId({ token: "" }),
    /Missing required Cloudflare API token/,
  );
});
