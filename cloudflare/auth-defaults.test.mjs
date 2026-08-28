import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Cloudflare production defaults require authenticated Clerk users", async () => {
  const [baseText, generator, dockerfile, workflow] = await Promise.all([
    read("cloudflare/wrangler.base.json"),
    read("cloudflare/generate-deploy-config.mjs"),
    read("Dockerfile.cloudflare"),
    read(".github/workflows/cloudflare-production-deploy.yml"),
  ]);
  const base = JSON.parse(baseText);

  assert.equal(base.vars.PILOT_AUTH_BYPASS, "false");
  assert.equal(base.vars.PILOT_AUTH_USER_ID, undefined);
  assert.ok(base.secrets.required.includes("CLERK_SECRET_KEY"));

  assert.match(generator, /PILOT_AUTH_BYPASS === "true"/);
  assert.doesNotMatch(generator, /PILOT_AUTH_BYPASS !== "false"/);
  assert.match(dockerfile, /ARG VITE_PILOT_AUTH_BYPASS=false/);
  assert.match(workflow, /PILOT_AUTH_BYPASS: "false"/);
  assert.doesNotMatch(workflow, /PILOT_AUTH_USER_ID:/);
});
