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
  assert.match(workflow, /- name: Resolve deployed container digest/);
  assert.match(
    workflow,
    /- name: Wait for exact workers\.dev rollout acceptance/,
  );

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

test("Cloudflare rollout acceptance cannot pass against the previous container", async () => {
  const workflow = await read(
    ".github/workflows/cloudflare-production-deploy.yml",
  );
  const waitStart = workflow.indexOf(
    "- name: Wait for exact workers.dev rollout acceptance",
  );
  const smokeStart = workflow.indexOf(
    "- name: Smoke-test workers.dev deployment",
  );
  assert.ok(waitStart > 0, "exact rollout gate must exist");
  assert.ok(smokeStart > waitStart, "smoke test must follow the rollout gate");

  const rolloutGate = workflow.slice(waitStart, smokeStart);
  assert.match(workflow, /container_tag=jack-core-production:/);
  assert.match(workflow, /registry\.cloudflare\.com\//);
  assert.match(workflow, /docker image inspect "\$registry_tag"/);
  assert.match(workflow, /\/jack-core-production@sha256:\[0-9a-f\]\{64\}\$/);
  assert.match(workflow, /expected_digest=\$expected_digest/);
  assert.match(rolloutGate, /timeout-minutes: 35/);
  assert.match(rolloutGate, /primary_attempts=120/);
  assert.match(rolloutGate, /terminal_grace_attempts=12/);
  assert.match(
    rolloutGate,
    /total_attempts=\$\(\(primary_attempts \+ terminal_grace_attempts\)\)/,
  );
  assert.match(rolloutGate, /for attempt in \$\(seq 1 "\$total_attempts"\)/);
  assert.match(rolloutGate, /attempt > primary_attempts/);
  assert.match(rolloutGate, /rollout_phase="terminal-grace"/);
  assert.match(rolloutGate, /phase=\$\{rollout_phase\}/);
  assert.match(rolloutGate, /attempt == primary_attempts/);
  assert.match(rolloutGate, /attempt < total_attempts/);
  assert.match(
    rolloutGate,
    /entering \$\{terminal_grace_attempts\}-attempt terminal reconciliation grace/,
  );
  assert.match(
    rolloutGate,
    /if \[\[ "\$ready" != "true" \]\]; then[\s\S]*terminal reconciliation grace\."\n\s+exit 1/,
  );
  assert.match(rolloutGate, /containers list --json/);
  assert.match(rolloutGate, /reported_digest="\$\{application_image##\*@\}"/);
  assert.match(rolloutGate, /reported_digest" == "\$expected_digest/);
  assert.match(rolloutGate, /application_state" =~ \^\(active\|ready\)\$/);
  assert.match(rolloutGate, /\/api\/healthz\?release=/);
  assert.match(rolloutGate, /\/api\/me\?release=/);
  assert.match(rolloutGate, /auth_status" == "401"/);
  assert.match(rolloutGate, /includes\("sign in required"\)/);
  assert.match(rolloutGate, /row\.name === "jack-production"/);
  assert.match(rolloutGate, /instance_state" == "running"/);
  assert.match(rolloutGate, /instance_version" == "\$application_version"/);
  assert.match(rolloutGate, /postprobe_instance_state" == "running"/);
  assert.match(
    rolloutGate,
    /postprobe_instance_version" == "\$application_version"/,
  );
  assert.match(
    rolloutGate,
    /image_match" == "true" && "\$instance_version_match" == "true" && "\$postprobe_instance_version_match" == "true" && "\$root_status" == "200" && "\$health_ok" == "true" && "\$auth_ok" == "true"/,
  );
  assert.match(rolloutGate, /containers instances "\$application_id" --json/);
  assert.doesNotMatch(
    rolloutGate,
    /if \[\[ "\$http_code" =~ \^2 \]\]; then\s+ready=true/,
  );
  assert.equal(
    rolloutGate.match(/\bready=true\b/g)?.length,
    1,
    "only the complete exact-version acceptance predicate may mark the gate ready",
  );

  const imageGate = rolloutGate.indexOf(
    'reported_digest="${application_image##*@}"',
  );
  const firstProbe = rolloutGate.indexOf("curl --silent");
  const acceptanceProbe = rolloutGate.indexOf("phase=acceptance");
  const authProof = rolloutGate.indexOf('auth_status" == "401"');
  const instanceProof = rolloutGate.indexOf(
    'instance_version" == "$application_version"',
  );
  const postprobeInstanceProof = rolloutGate.indexOf(
    'postprobe_instance_version" == "$application_version"',
  );
  const acceptance = rolloutGate.lastIndexOf("ready=true");
  assert.ok(
    imageGate >= 0 && imageGate < firstProbe,
    "verify the image before probing",
  );
  assert.ok(
    authProof >= 0 && authProof < acceptance,
    "prove fail-closed auth before accepting",
  );
  assert.ok(
    instanceProof >= 0 && instanceProof < acceptance,
    "prove the serving instance version before accepting",
  );
  assert.ok(
    instanceProof >= 0 && instanceProof < acceptanceProbe,
    "prove the serving instance version before acceptance probes",
  );
  assert.ok(
    postprobeInstanceProof > authProof && postprobeInstanceProof < acceptance,
    "re-prove the serving instance version after acceptance probes",
  );
});
