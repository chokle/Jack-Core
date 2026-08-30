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

function workflowSteps(workflow) {
  const marker = "\n    steps:\n";
  const stepsStart = workflow.indexOf(marker);
  assert.ok(stepsStart >= 0, "production workflow steps must exist");
  const stepsText = workflow.slice(stepsStart + marker.length);
  const starts = [
    ...stepsText.matchAll(/^      -(?:[ \t]+(?=\S)|[ \t]*$)/gm),
  ].map(({ index }) => index);
  return starts.map((start, position) =>
    stepsText.slice(start, starts[position + 1] ?? stepsText.length),
  );
}

function stepIdentity(step) {
  const name = step.match(/^(?:      - |        )name:\s*(.+)$/m)?.[1];
  if (name) return name;
  const action = step.match(/^(?:      - |        )uses:\s*(.+)$/m)?.[1];
  if (action) return `uses: ${action}`;
  const command = step.match(/^\s+(?:- )?run:\s*([^|>\n].*)$/m)?.[1];
  if (command) return `run: ${command}`;
  return step.split(/\r?\n/, 1)[0].trim();
}

function stepTimeoutMinutes(step) {
  const matches = [
    ...step.matchAll(/^(?:      - |        )timeout-minutes:\s*(\d+)\s*$/gm),
  ];
  assert.equal(
    matches.length,
    1,
    `${stepIdentity(step)} must declare exactly one integer timeout-minutes cap`,
  );
  const minutes = Number.parseInt(matches[0][1], 10);
  assert.ok(minutes > 0, `${stepIdentity(step)} timeout must be positive`);
  return minutes;
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
    /- name: Generate Cloudflare deploy config\n\s+timeout-minutes: \d+\n\s+env:\n\s+VITE_CLERK_PUBLISHABLE_KEY: \$\{\{ secrets\.VITE_CLERK_PUBLISHABLE_KEY \}\}/,
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
  const steps = workflowSteps(workflow);
  const rolloutIndex = steps.findIndex(
    (step) =>
      stepIdentity(step) === "Wait for exact workers.dev rollout acceptance",
  );
  assert.ok(rolloutIndex > 0, "rollout acceptance must follow pre-gate steps");
  const preGateSteps = steps.slice(0, rolloutIndex);
  const postGateSteps = steps.slice(rolloutIndex + 1);
  const preGateIdentities = preGateSteps.map(stepIdentity);
  assert.deepEqual(preGateIdentities.slice(-3), [
    "Deploy Worker + Container to workers.dev",
    "Resolve deployed workers.dev target",
    "Resolve deployed container digest",
  ]);
  const preGateTimeouts = preGateSteps.map(stepTimeoutMinutes);
  assert.equal(
    preGateTimeouts.length,
    preGateSteps.length,
    "every pre-gate step must contribute one enforceable timeout",
  );
  const preGateMinutes = preGateTimeouts.reduce(
    (total, minutes) => total + minutes,
    0,
  );
  assert.deepEqual(postGateSteps.map(stepIdentity), [
    "Smoke-test workers.dev deployment",
    "Capture failed startup diagnostics",
    "Record deployment evidence",
  ]);
  const postGateTimeouts = postGateSteps.map(stepTimeoutMinutes);
  assert.equal(
    postGateTimeouts.length,
    postGateSteps.length,
    "every post-gate step must contribute one enforceable timeout",
  );
  const postGateMinutes = postGateTimeouts.reduce(
    (total, minutes) => total + minutes,
    0,
  );

  const jobMinutes = integerMatch(
    jobHeader,
    /timeout-minutes:\s*(\d+)/,
    "production job timeout",
  );
  const deployCommandMinutes = integerMatch(
    deployStep,
    /timeout --kill-after=\d+s (\d+)m npx --yes wrangler@4\.127\.1 deploy/,
    "bounded deploy command",
  );
  const deployKillAfterSeconds = integerMatch(
    deployStep,
    /timeout --kill-after=(\d+)s \d+m npx --yes wrangler@4\.127\.1 deploy/,
    "deploy kill-after bound",
  );
  const rolloutMinutes = stepTimeoutMinutes(rolloutStep);
  assert.equal(rolloutMinutes, 35, "rollout gate must retain its 35m cap");
  const smokeMinutes = stepTimeoutMinutes(smokeStep);
  const diagnosticsMinutes = stepTimeoutMinutes(diagnosticsStep);
  assert.equal(
    diagnosticsMinutes,
    5,
    "failed startup diagnostics must retain its 5m cap",
  );
  const headroomMinutes = integerMatch(
    workflow,
    /CLOUDFLARE_JOB_HEADROOM_MINUTES:\s*"(\d+)"/,
    "job headroom",
  );
  const requiredJobMinutes =
    preGateMinutes + rolloutMinutes + postGateMinutes + headroomMinutes;
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
  const diagnosticWorstCaseSeconds =
    diagnosticWranglerBounds.reduce(
      (total, match) => total + Number(match[1]) + Number(match[2]),
      0,
    ) +
    diagnosticProbeBounds.reduce(
      (total, match) => total + Number(match[1]),
      0,
    ) +
    diagnosticSleeps.reduce((total, match) => total + Number(match[1]), 0);
  const smokeWorstCaseSeconds = smokeProbeBounds.reduce(
    (total, match) => total + Number(match[1]),
    0,
  );

  assert.ok(
    stepTimeoutMinutes(deployStep) * 60 >=
      deployCommandMinutes * 60 + deployKillAfterSeconds,
    "deploy step timeout must cover the command timeout and kill-after window",
  );
  assert.equal(
    jobMinutes,
    requiredJobMinutes,
    `job timeout ${jobMinutes}m must equal enforceable pre-gate steps ${preGateMinutes}m + rollout ${rolloutMinutes}m + post-gate steps ${postGateMinutes}m + headroom ${headroomMinutes}m`,
  );
  assert.ok(
    diagnosticsMinutes * 60 >= diagnosticWorstCaseSeconds,
    `diagnostics step ${diagnosticsMinutes}m must cover its ${diagnosticWorstCaseSeconds}s bounded command path`,
  );
  assert.ok(
    smokeMinutes * 60 >= smokeWorstCaseSeconds,
    `smoke step ${smokeMinutes}m must cover its ${smokeWorstCaseSeconds}s bounded probe path`,
  );

  const unboundedMutation = workflow.replace(
    "      - name: Wait for exact workers.dev rollout acceptance",
    [
      "      - id: unbounded_pre_gate",
      "        name: Newly added unbounded pre-gate work",
      "        run: node -e 'setInterval(() => {}, 1000)'",
      "",
      "      - name: Wait for exact workers.dev rollout acceptance",
    ].join("\n"),
  );
  const mutatedSteps = workflowSteps(unboundedMutation);
  const mutatedRolloutIndex = mutatedSteps.findIndex(
    (step) =>
      stepIdentity(step) === "Wait for exact workers.dev rollout acceptance",
  );
  assert.throws(
    () => mutatedSteps.slice(0, mutatedRolloutIndex).map(stepTimeoutMinutes),
    /Newly added unbounded pre-gate work must declare exactly one integer timeout-minutes cap/,
  );

  const bareDashMutation = workflow.replace(
    "      - name: Wait for exact workers.dev rollout acceptance",
    [
      "      -",
      "        id: bare_dash_unbounded_pre_gate",
      "        name: Bare-dash unbounded pre-gate work",
      "        run: node -e 'setInterval(() => {}, 1000)'",
      "",
      "      - name: Wait for exact workers.dev rollout acceptance",
    ].join("\n"),
  );
  const bareDashSteps = workflowSteps(bareDashMutation);
  const bareDashRolloutIndex = bareDashSteps.findIndex(
    (step) =>
      stepIdentity(step) === "Wait for exact workers.dev rollout acceptance",
  );
  assert.throws(
    () => bareDashSteps.slice(0, bareDashRolloutIndex).map(stepTimeoutMinutes),
    /Bare-dash unbounded pre-gate work must declare exactly one integer timeout-minutes cap/,
  );
});
