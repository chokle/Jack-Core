import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

function stepBody(workflow, name) {
  const start = workflow.indexOf(`- name: ${name}`);
  assert.ok(start >= 0, `${name} step must exist`);
  const next = workflow.indexOf("\n      - name:", start + 1);
  return workflow.slice(start, next < 0 ? workflow.length : next);
}

function integerMatch(text, pattern, label) {
  const match = text.match(pattern);
  assert.ok(match, `${label} must be declared`);
  return Number.parseInt(match[1], 10);
}

function workflowWranglerCommands(workflow) {
  return [
    ...workflow.matchAll(
      /(?<command>(?:npx\s+--yes\s+)?wrangler(?:@[^\s"'\\]+)?)(?=\s)/g,
    ),
  ].map(({ groups }) => groups.command);
}

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
  const [workflow, verificationWorkflow, gate, runner] = await Promise.all([
    read(".github/workflows/cloudflare-production-deploy.yml"),
    read(".github/workflows/cloudflare-cutover-verify.yml"),
    read("cloudflare/rollout-acceptance.mjs"),
    read("cloudflare/run-rollout-acceptance.mjs"),
  ]);
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
  assert.match(
    rolloutGate,
    /CLOUDFLARE_ROLLOUT_TARGET: \$\{\{ steps\.deployment\.outputs\.target \}\}/,
  );
  assert.match(
    rolloutGate,
    /CLOUDFLARE_ROLLOUT_RELEASE: \$\{\{ steps\.deployment\.outputs\.version_id \}\}/,
  );
  assert.match(
    rolloutGate,
    /CLOUDFLARE_EXPECTED_DIGEST: \$\{\{ steps\.container\.outputs\.expected_digest \}\}/,
  );
  assert.match(
    rolloutGate,
    /run: node cloudflare\/run-rollout-acceptance\.mjs/,
  );
  assert.match(gate, /primaryAttempts: 120/);
  assert.match(gate, /transitionDeadlineMs: 33 \* 60_000/);
  assert.match(gate, /acceptanceDeadlineMs: 34\.5 \* 60_000/);
  assert.match(gate, /matches\.length === 1/);
  assert.match(gate, /instance\.id === admission\.instanceId/);
  assert.match(gate, /application\.digest === admission\.digest/);
  assert.match(gate, /postprobeApplication/);
  assert.match(gate, /postprobeInstance/);
  assert.match(gate, /anonymousMe\.status === 401/);
  assert.match(gate, /includes\("sign in required"\)/);
  assert.match(runner, /WRANGLER_VERSION = "4\.127\.1"/);
  assert.match(runner, /"--search",\s+"jack-production"/);
  assert.match(runner, /"--per-page",\s+"100"/);
  const pinnedCommand = "npx --yes wrangler@4.127.1";
  assert.deepEqual(workflowWranglerCommands(workflow), [
    pinnedCommand,
    pinnedCommand,
    pinnedCommand,
    pinnedCommand,
    pinnedCommand,
    pinnedCommand,
  ]);
  assert.deepEqual(workflowWranglerCommands(verificationWorkflow), [
    pinnedCommand,
  ]);
});

test("Cloudflare production job budget cannot preempt rollout diagnostics", async () => {
  const workflow = await read(
    ".github/workflows/cloudflare-production-deploy.yml",
  );
  const jobHeader = workflow.slice(
    workflow.indexOf("  verify-and-deploy:"),
    workflow.indexOf("    steps:"),
  );
  const deployStep = stepBody(
    workflow,
    "Deploy Worker + Container to workers.dev",
  );
  const rolloutStep = stepBody(
    workflow,
    "Wait for exact workers.dev rollout acceptance",
  );
  const smokeStep = stepBody(workflow, "Smoke-test workers.dev deployment");
  const diagnosticsStep = stepBody(
    workflow,
    "Capture failed startup diagnostics",
  );

  const jobMinutes = integerMatch(
    jobHeader,
    /timeout-minutes:\s*(\d+)/,
    "production job timeout",
  );
  const setupBuildMinutes = integerMatch(
    workflow,
    /CLOUDFLARE_SETUP_BUILD_BUDGET_MINUTES:\s*"(\d+)"/,
    "setup/build budget",
  );
  const deployMinutes = integerMatch(
    deployStep,
    /timeout --kill-after=\d+s (\d+)m npx --yes wrangler@4\.127\.1 deploy/,
    "bounded deploy budget",
  );
  const rolloutMinutes = integerMatch(
    rolloutStep,
    /timeout-minutes:\s*(\d+)/,
    "rollout acceptance budget",
  );
  const postGateMinutes = integerMatch(
    workflow,
    /CLOUDFLARE_POST_GATE_BUDGET_MINUTES:\s*"(\d+)"/,
    "post-gate diagnostics budget",
  );
  const headroomMinutes = integerMatch(
    workflow,
    /CLOUDFLARE_JOB_HEADROOM_MINUTES:\s*"(\d+)"/,
    "job headroom",
  );
  const requiredJobMinutes =
    setupBuildMinutes +
    deployMinutes +
    rolloutMinutes +
    postGateMinutes +
    headroomMinutes;
  const diagnosticWranglerBounds = [
    ...diagnosticsStep.matchAll(
      /timeout --kill-after=(\d+)s (\d+)s npx --yes wrangler@4\.127\.1/g,
    ),
  ];
  const diagnosticProbeBounds = [
    ...diagnosticsStep.matchAll(/--max-time (\d+)/g),
  ];
  const diagnosticCurlCommands = [...diagnosticsStep.matchAll(/\bcurl(?=\s)/g)];
  const diagnosticSleeps = [
    ...diagnosticsStep.matchAll(/^\s*sleep (\d+)\s*$/gm),
  ];
  const diagnosticSleepCommands = [
    ...diagnosticsStep.matchAll(/\bsleep(?=\s)/g),
  ];
  const smokeProbeBounds = [...smokeStep.matchAll(/--max-time (\d+)/g)];
  const smokeCurlCommands = [...smokeStep.matchAll(/\bcurl(?=\s)/g)];
  assert.equal(
    diagnosticWranglerBounds.length,
    3,
    "all three diagnostic Wrangler commands must remain explicitly bounded",
  );
  assert.equal(
    diagnosticProbeBounds.length,
    1,
    "the diagnostic HTTP probe must remain explicitly bounded",
  );
  assert.equal(
    diagnosticCurlCommands.length,
    diagnosticProbeBounds.length,
    "every diagnostic curl command must have an explicit max-time bound",
  );
  assert.equal(
    diagnosticSleeps.length,
    1,
    "the diagnostic startup delay must remain explicit",
  );
  assert.equal(
    diagnosticSleepCommands.length,
    diagnosticSleeps.length,
    "every diagnostic sleep must have an explicit numeric bound",
  );
  assert.equal(
    smokeProbeBounds.length,
    3,
    "all three post-gate smoke probes must remain explicitly bounded",
  );
  assert.equal(
    smokeCurlCommands.length,
    smokeProbeBounds.length,
    "every post-gate smoke curl command must have an explicit max-time bound",
  );
  const postGateWorstCaseSeconds =
    diagnosticWranglerBounds.reduce(
      (total, match) => total + Number(match[1]) + Number(match[2]),
      0,
    ) +
    diagnosticProbeBounds.reduce(
      (total, match) => total + Number(match[1]),
      0,
    ) +
    diagnosticSleeps.reduce((total, match) => total + Number(match[1]), 0) +
    smokeProbeBounds.reduce((total, match) => total + Number(match[1]), 0);

  assert.ok(
    jobMinutes >= requiredJobMinutes,
    `job timeout ${jobMinutes}m must cover setup/build ${setupBuildMinutes}m + deploy ${deployMinutes}m + rollout ${rolloutMinutes}m + post-gate diagnostics ${postGateMinutes}m + headroom ${headroomMinutes}m`,
  );
  assert.ok(
    postGateMinutes * 60 >= postGateWorstCaseSeconds,
    `post-gate budget ${postGateMinutes}m must cover the workflow's ${postGateWorstCaseSeconds}s bounded smoke-plus-diagnostics path`,
  );
});
