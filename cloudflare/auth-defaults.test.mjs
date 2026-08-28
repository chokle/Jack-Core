import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Cloudflare production defaults require authenticated Clerk users", async () => {
  const [baseText, generator, dockerfile, workflow, verifyWorkflow] = await Promise.all([
    read("cloudflare/wrangler.base.json"),
    read("cloudflare/generate-deploy-config.mjs"),
    read("Dockerfile.cloudflare"),
    read(".github/workflows/cloudflare-production-deploy.yml"),
    read(".github/workflows/cloudflare-cutover-verify.yml"),
  ]);
  const base = JSON.parse(baseText);

  assert.equal(base.vars.PILOT_AUTH_BYPASS, "false");
  assert.equal(base.vars.PILOT_AUTH_USER_ID, undefined);
  assert.deepEqual(base.secrets.required, [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "CLERK_SECRET_KEY",
    "OPENAI_API_KEY",
    "ADMIN_EMAILS",
  ]);

  assert.match(generator, /PILOT_AUTH_BYPASS === "true"/);
  assert.doesNotMatch(generator, /PILOT_AUTH_BYPASS !== "false"/);
  assert.match(dockerfile, /ARG VITE_PILOT_AUTH_BYPASS=false/);
  assert.match(dockerfile, /ARG VITE_PUBLIC_DEMO_URL=/);
  assert.match(dockerfile, /ENV VITE_PUBLIC_DEMO_URL=\$VITE_PUBLIC_DEMO_URL/);
  assert.match(workflow, /PILOT_AUTH_BYPASS: "false"/);
  assert.doesNotMatch(workflow, /PILOT_AUTH_USER_ID:/);
  assert.match(workflow, /vars\.VITE_PUBLIC_DEMO_URL/);
  assert.match(workflow, /--build-arg VITE_PUBLIC_DEMO_URL=/);
  assert.match(verifyWorkflow, /--build-arg VITE_PUBLIC_DEMO_URL=/);
  assert.match(verifyWorkflow, /grep -R -F "\$VITE_PUBLIC_DEMO_URL"/);
  assert.match(workflow, /--secrets-file/);
  assert.match(workflow, /cloudflare-secrets\.json/);
  assert.match(workflow, /X-Jack-Diagnostic:ci-smoke/);

  const jobHeader = workflow.slice(
    workflow.indexOf("jobs:"),
    workflow.indexOf("    steps:"),
  );
  for (const secretName of [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "CLERK_SECRET_KEY",
    "OPENAI_API_KEY",
    "ADMIN_EMAILS",
  ]) {
    assert.doesNotMatch(
      jobHeader,
      new RegExp(secretName),
      `${secretName} must not be exposed job-wide`,
    );
    assert.equal(
      workflow.match(new RegExp(`secrets\\.${secretName}`, "g"))?.length,
      2,
      `${secretName} should be bound only to preflight and secret handoff`,
    );
  }
});
