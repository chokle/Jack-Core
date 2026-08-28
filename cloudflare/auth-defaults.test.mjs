import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Cloudflare production defaults require authenticated Clerk users", async () => {
  const [baseText, generator, dockerfile, workflow, worker] =
    await Promise.all([
      read("cloudflare/wrangler.base.json"),
      read("cloudflare/generate-deploy-config.mjs"),
      read("Dockerfile.cloudflare"),
      read(".github/workflows/cloudflare-production-deploy.yml"),
      read("cloudflare/worker.mjs"),
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
  assert.match(workflow, /PILOT_AUTH_BYPASS: "false"/);
  assert.doesNotMatch(workflow, /PILOT_AUTH_USER_ID:/);
  assert.match(workflow, /--secrets-file/);
  assert.match(workflow, /cloudflare-secrets\.json/);
  assert.match(workflow, /X-Jack-Diagnostic:ci-smoke/);
  assert.match(
    workflow,
    /- name: Generate Cloudflare deploy config\n\s+env:\n\s+VITE_CLERK_PUBLISHABLE_KEY: \$\{\{ secrets\.VITE_CLERK_PUBLISHABLE_KEY \}\}/,
  );
  assert.equal(
    workflow.match(/secrets\.VITE_CLERK_PUBLISHABLE_KEY/g)?.length,
    3,
    "Clerk publishable key must be bound to preflight, config generation, and container build",
  );
  assert.match(workflow, /- name: Wait for workers\.dev container readiness/);
  assert.match(workflow, /timeout-minutes: 8/);
  assert.match(workflow, /for attempt in \$\(seq 1 42\)/);
  assert.match(workflow, /containers list --json/);
  assert.match(workflow, /containers instances "\$application_id" --json/);

  assert.match(worker, /STARTUP_PROBE_TIMEOUT_MS = 2000/);
  assert.match(worker, /Promise\.race/);
  assert.match(worker, /\/api\/healthz/);
  assert.match(worker, /await this\.waitForReadiness\(port\)/);
  assert.match(worker, /return await port\.fetch\(request\)/);

  const readinessIndex = worker.indexOf("await this.waitForReadiness(port)");
  const forwardIndex = worker.indexOf("return await port.fetch(request)");
  assert.ok(readinessIndex >= 0 && forwardIndex > readinessIndex);

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
