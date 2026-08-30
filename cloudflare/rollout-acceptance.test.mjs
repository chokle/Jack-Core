import assert from "node:assert/strict";
import test from "node:test";
import {
  ROLLOUT_DEFAULTS,
  runRolloutAcceptance,
} from "./rollout-acceptance.mjs";
import {
  createProductionRolloutAdapter,
  runBoundedCommand,
  WRANGLER_VERSION,
} from "./run-rollout-acceptance.mjs";

const DIGEST = `sha256:${"a".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"b".repeat(64)}`;
const TARGET = "https://jack-core-production.example.workers.dev";
const RELEASE = "11111111-2222-3333-4444-555555555555";

function application(overrides = {}) {
  return {
    name: "jack-core-production",
    id: "app-1",
    state: "active",
    image: `registry.cloudflare.com/account/jack-core-production@${DIGEST}`,
    version: 14,
    ...overrides,
  };
}

function instance(overrides = {}) {
  return {
    name: "jack-production",
    id: "instance-1",
    state: "running",
    version: 14,
    ...overrides,
  };
}

function createFakeClock() {
  let currentMs = 0;
  const sleeps = [];
  return {
    now: () => currentMs,
    sleep: async (delayMs) => {
      assert.ok(delayMs >= 0, "sleep must be non-negative");
      sleeps.push({ from: currentMs, delayMs, to: currentMs + delayMs });
      currentMs += delayMs;
    },
    advance: (delayMs) => {
      currentMs += delayMs;
    },
    sleeps,
  };
}

function resolveSpec(spec, context, fallback) {
  const selected = spec ?? fallback;
  if (typeof selected === "function") return selected(context);
  return selected;
}

function createAdapter({ clock, applications, instances, probes = {} } = {}) {
  const calls = {
    applications: 0,
    instances: 0,
    probes: [],
    events: [],
  };
  const adapter = {
    async listApplications({ timeoutMs }) {
      calls.applications += 1;
      calls.events.push(`applications:${calls.applications}`);
      assert.ok(timeoutMs > 0, "application reads must be bounded");
      return resolveSpec(
        applications,
        { call: calls.applications, clock, timeoutMs, calls },
        [application()],
      );
    },
    async listInstances(applicationId, { timeoutMs }) {
      calls.instances += 1;
      calls.events.push(`instances:${calls.instances}`);
      assert.equal(applicationId, "app-1");
      assert.ok(timeoutMs > 0, "instance reads must be bounded");
      return resolveSpec(
        instances,
        { call: calls.instances, clock, timeoutMs, calls },
        [instance()],
      );
    },
    async probe(arguments_) {
      calls.probes.push(arguments_);
      calls.events.push(`probe:${arguments_.kind}`);
      assert.ok(arguments_.timeoutMs > 0, "probes must be bounded");
      const defaults = {
        warmup: { status: 200, body: "" },
        root: { status: 200, body: "<html></html>" },
        health: { status: 200, body: JSON.stringify({ status: "ok" }) },
        "anonymous-me": {
          status: 401,
          body: JSON.stringify({ error: "Sign in required" }),
        },
      };
      return resolveSpec(
        probes[arguments_.kind],
        {
          call: calls.probes.filter((entry) => entry.kind === arguments_.kind)
            .length,
          clock,
          timeoutMs: arguments_.timeoutMs,
          calls,
        },
        defaults[arguments_.kind],
      );
    },
  };
  return { adapter, calls };
}

async function runScenario({ adapter, clock, config, logger } = {}) {
  return runRolloutAcceptance({
    target: TARGET,
    release: RELEASE,
    expectedDigest: DIGEST,
    adapter,
    clock,
    config,
    logger,
  });
}

test("production timing keeps 120 primary attempts and hard internal deadlines", () => {
  assert.equal(ROLLOUT_DEFAULTS.primaryAttempts, 120);
  assert.equal(ROLLOUT_DEFAULTS.transitionDeadlineMs, 33 * 60_000);
  assert.equal(ROLLOUT_DEFAULTS.acceptanceDeadlineMs, 34.5 * 60_000);
  assert.ok(
    ROLLOUT_DEFAULTS.acceptanceDeadlineMs < 35 * 60_000,
    "the internal acceptance deadline must leave headroom under the workflow step timeout",
  );
});

test("an immediate exact same-version running instance passes only after the full transaction", async () => {
  const clock = createFakeClock();
  const { adapter, calls } = createAdapter({ clock });
  const result = await runScenario({ adapter, clock, logger: () => {} });

  assert.equal(result.ready, true);
  assert.equal(result.code, "accepted");
  assert.deepEqual(calls.events.slice(-5), [
    "probe:root",
    "probe:health",
    "probe:anonymous-me",
    "applications:3",
    "instances:3",
  ]);
  assert.equal(result.snapshot.postprobeApplication.exact, true);
  assert.equal(result.snapshot.postprobeInstance.identityVersionMatch, true);
  assert.equal(result.snapshot.postprobeInstance.state, "running");
});

test("an initially running candidate retries a transient preprobe control-plane read", async () => {
  const clock = createFakeClock();
  const logs = [];
  const { adapter, calls } = createAdapter({
    clock,
    applications: ({ call }) => {
      if (call === 2) throw new Error("temporary preprobe read failure");
      return [application()];
    },
  });
  const result = await runScenario({
    adapter,
    clock,
    logger: (line) => logs.push(line),
    config: { terminalPollIntervalMs: 1 },
  });

  assert.equal(result.ready, true);
  assert.equal(result.code, "accepted");
  assert.deepEqual(result.admission, {
    admittedAtMs: 0,
    applicationId: "app-1",
    digest: DIGEST,
    applicationVersion: "14",
    instanceId: "instance-1",
    instanceVersion: "14",
  });
  assert.equal(calls.applications, 4);
  assert.equal(calls.instances, 3);
  assert.equal(calls.probes.filter(({ kind }) => kind === "root").length, 1);
  assert.match(logs.join("\n"), /full transaction will restart/);
});

test("an initially running candidate restarts the full transaction after a transient postprobe read", async () => {
  const clock = createFakeClock();
  const logs = [];
  const { adapter, calls } = createAdapter({
    clock,
    instances: ({ call }) => {
      if (call === 3) throw new Error("temporary postprobe read failure");
      return [instance()];
    },
  });
  const result = await runScenario({
    adapter,
    clock,
    logger: (line) => logs.push(line),
    config: { terminalPollIntervalMs: 1 },
  });

  assert.equal(result.ready, true);
  assert.equal(result.code, "accepted");
  assert.notEqual(result.admission, null);
  assert.equal(calls.applications, 5);
  assert.equal(calls.instances, 5);
  assert.equal(calls.probes.filter(({ kind }) => kind === "root").length, 2);
  assert.match(logs.join("\n"), /full transaction will restart/);
});

test("an initially running admission never retries drift or public probe failure", async (t) => {
  await t.test("drift after a transient read", async () => {
    const clock = createFakeClock();
    const { adapter, calls } = createAdapter({
      clock,
      applications: ({ call }) => {
        if (call === 2) throw new Error("temporary preprobe read failure");
        return [
          application(
            call === 3
              ? {
                  image: `registry.cloudflare.com/account/jack-core-production@${OTHER_DIGEST}`,
                }
              : undefined,
          ),
        ];
      },
    });
    const result = await runScenario({
      adapter,
      clock,
      logger: () => {},
      config: { terminalPollIntervalMs: 1 },
    });

    assert.equal(result.ready, false);
    assert.equal(result.code, "application-drift");
    assert.notEqual(result.admission, null);
    assert.equal(calls.probes.filter(({ kind }) => kind === "root").length, 0);
  });

  await t.test("public probe failure after a transient read", async () => {
    const clock = createFakeClock();
    const { adapter, calls } = createAdapter({
      clock,
      applications: ({ call }) => {
        if (call === 2) throw new Error("temporary preprobe read failure");
        return [application()];
      },
      probes: {
        root: () => {
          throw new Error("public network failure");
        },
      },
    });
    const result = await runScenario({
      adapter,
      clock,
      logger: () => {},
      config: { terminalPollIntervalMs: 1 },
    });

    assert.equal(result.ready, false);
    assert.equal(result.code, "root-probe-failed");
    assert.notEqual(result.admission, null);
    assert.equal(calls.applications, 3);
    assert.equal(calls.probes.filter(({ kind }) => kind === "root").length, 1);
  });
});

test("a stopped instance transitioning at 32:30 passes before both internal deadlines", async () => {
  const clock = createFakeClock();
  const { adapter } = createAdapter({
    clock,
    instances: ({ clock: fakeClock }) => [
      instance({
        state: fakeClock.now() >= 32.5 * 60_000 ? "running" : "stopped",
      }),
    ],
  });
  const result = await runScenario({
    adapter,
    clock,
    logger: () => {},
    config: {
      primaryPollIntervalMs: 16_302,
      terminalPollIntervalMs: 1_000,
    },
  });

  assert.equal(result.ready, true);
  assert.equal(result.snapshot.primaryAttempt, 120);
  assert.ok(result.elapsedMs >= 32.5 * 60_000);
  assert.ok(result.elapsedMs <= 33 * 60_000);
});

test("a transition after 33:00 fails without observing or sleeping past the deadline", async () => {
  const clock = createFakeClock();
  const { adapter } = createAdapter({
    clock,
    instances: ({ clock: fakeClock }) => [
      instance({
        state: fakeClock.now() > 33 * 60_000 ? "running" : "stopped",
      }),
    ],
  });
  const result = await runScenario({
    adapter,
    clock,
    logger: () => {},
    config: {
      primaryPollIntervalMs: 16_302,
      terminalPollIntervalMs: 1_000,
    },
  });

  assert.equal(result.ready, false);
  assert.equal(result.code, "transition-deadline");
  assert.ok(clock.now() < 33 * 60_000);
  assert.ok(clock.sleeps.every(({ to }) => to < 33 * 60_000));
});

const admissionDivergences = [
  ["duplicate application", { applications: [application(), application()] }],
  ["missing application id", { applications: [application({ id: "" })] }],
  [
    "missing application version",
    { applications: [application({ version: "" })] },
  ],
  [
    "wrong digest",
    {
      applications: [
        application({
          image: `registry.cloudflare.com/account/jack-core-production@${OTHER_DIGEST}`,
        }),
      ],
    },
  ],
  [
    "non-ready application",
    { applications: [application({ state: "deploying" })] },
  ],
  ["warmup is not 200", { probes: { warmup: { status: 503, body: "" } } }],
  [
    "duplicate named instance",
    {
      instances: [
        instance({ state: "stopped" }),
        instance({ state: "stopped" }),
      ],
    },
  ],
  [
    "missing instance id",
    { instances: [instance({ id: "", state: "stopped" })] },
  ],
  [
    "instance version mismatch",
    { instances: [instance({ version: 13, state: "stopped" })] },
  ],
  [
    "instance is neither stopped nor running",
    { instances: [instance({ state: "starting" })] },
  ],
];

for (const [name, scenario] of admissionDivergences) {
  test(`terminal admission rejects ${name}`, async () => {
    const clock = createFakeClock();
    const { adapter } = createAdapter({ clock, ...scenario });
    const result = await runScenario({
      adapter,
      clock,
      logger: () => {},
      config: { primaryAttempts: 1 },
    });

    assert.equal(result.ready, false);
    assert.equal(result.admission, null);
    assert.equal(result.code, "primary-exhausted-without-terminal-admission");
  });
}

test("a transient pre-admission warmup transport error retries and can pass", async (t) => {
  for (const [name, failWarmup, expectedLog] of [
    [
      "network error",
      () => {
        throw new Error("temporary warmup network failure");
      },
      /temporary warmup network failure/,
    ],
    [
      "bounded timeout",
      ({ clock: fakeClock, timeoutMs }) => {
        fakeClock.advance(timeoutMs);
        throw new Error("temporary warmup timeout");
      },
      /warmup probe exceeded its bounded 10ms operation window/,
    ],
  ]) {
    await t.test(name, async () => {
      const clock = createFakeClock();
      const logs = [];
      const { adapter, calls } = createAdapter({
        clock,
        probes: {
          warmup: (context) =>
            context.call === 1
              ? failWarmup(context)
              : { status: 200, body: "" },
        },
      });
      const result = await runScenario({
        adapter,
        clock,
        logger: (line) => logs.push(line),
        config: {
          primaryAttempts: 2,
          primaryPollIntervalMs: 1,
          transitionDeadlineMs: 100,
          acceptanceDeadlineMs: 200,
          warmupTimeoutMs: 10,
          wranglerCommandTimeoutMs: 10,
          probeTimeoutMs: 10,
        },
      });

      assert.equal(result.ready, true);
      assert.equal(result.code, "accepted");
      assert.equal(result.snapshot.primaryAttempt, 2);
      assert.equal(
        calls.probes.filter(({ kind }) => kind === "warmup").length,
        2,
      );
      assert.match(logs.join("\n"), expectedLog);
    });
  }
});

test("post-admission warmup transport and HTTP failures retry without acceptance", async (t) => {
  for (const [name, failedWarmup] of [
    [
      "transport error",
      () => {
        throw new Error("warmup transport lost");
      },
    ],
    ["non-200 response", () => ({ status: 503, body: "" })],
  ]) {
    await t.test(name, async () => {
      const clock = createFakeClock();
      const { adapter, calls } = createAdapter({
        clock,
        instances: ({ call }) => [
          instance({ state: call === 1 ? "stopped" : "running" }),
        ],
        probes: {
          warmup: (context) =>
            context.call === 2
              ? failedWarmup(context)
              : { status: 200, body: "" },
        },
      });
      const result = await runScenario({
        adapter,
        clock,
        logger: () => {},
        config: { primaryAttempts: 3, primaryPollIntervalMs: 1 },
      });

      assert.equal(result.ready, true);
      assert.equal(result.code, "accepted");
      assert.notEqual(result.admission, null);
      assert.equal(result.snapshot.primaryAttempt, 3);
      assert.equal(
        calls.probes.filter(({ kind }) => kind === "warmup").length,
        3,
      );
      assert.equal(
        calls.probes.filter(({ kind }) => kind === "root").length,
        1,
      );
    });
  }
});

test("a transient terminal API read retries only from pinned admission and never accepts stale data", async () => {
  const clock = createFakeClock();
  const logs = [];
  const { adapter, calls } = createAdapter({
    clock,
    applications: ({ call }) => {
      if (call === 2) throw new Error("temporary control-plane read failure");
      return [application()];
    },
    instances: ({ call }) => [
      instance({ state: call === 1 ? "stopped" : "running" }),
    ],
  });
  const result = await runScenario({
    adapter,
    clock,
    logger: (line) => logs.push(line),
    config: {
      primaryAttempts: 1,
      terminalPollIntervalMs: 1,
    },
  });

  assert.equal(result.ready, true);
  assert.match(logs.join("\n"), /stale admission cannot be accepted/);
  assert.equal(
    calls.instances,
    4,
    "the stale failed application read must not trigger an instance read",
  );
});

test("a bounded terminal read timeout retries from pinned admission before the absolute deadline", async () => {
  const clock = createFakeClock();
  const logs = [];
  const { adapter } = createAdapter({
    clock,
    applications: ({ call, clock: fakeClock, timeoutMs }) => {
      if (call === 2) {
        fakeClock.advance(timeoutMs);
        throw new Error("temporary Wrangler timeout");
      }
      return [application()];
    },
    instances: ({ call }) => [
      instance({ state: call === 1 ? "stopped" : "running" }),
    ],
  });
  const result = await runScenario({
    adapter,
    clock,
    logger: (line) => logs.push(line),
    config: {
      primaryAttempts: 1,
      terminalPollIntervalMs: 1,
      transitionDeadlineMs: 100,
      acceptanceDeadlineMs: 200,
      wranglerCommandTimeoutMs: 10,
      warmupTimeoutMs: 10,
      probeTimeoutMs: 10,
    },
  });

  assert.equal(result.ready, true);
  assert.equal(result.code, "accepted");
  assert.notEqual(result.admission, null);
  assert.equal(result.snapshot.terminalPoll, 2);
  assert.match(logs.join("\n"), /exceeded its bounded 10ms operation window/);
});

test("an operation that reaches the absolute phase deadline remains fatal", async () => {
  const clock = createFakeClock();
  const { adapter } = createAdapter({
    clock,
    applications: ({ clock: fakeClock, timeoutMs }) => {
      fakeClock.advance(timeoutMs);
      throw new Error("Wrangler did not answer");
    },
  });
  const result = await runScenario({
    adapter,
    clock,
    logger: () => {},
    config: {
      primaryAttempts: 2,
      transitionDeadlineMs: 10,
      acceptanceDeadlineMs: 20,
      wranglerCommandTimeoutMs: 10,
      warmupTimeoutMs: 10,
      probeTimeoutMs: 10,
    },
  });

  assert.equal(result.ready, false);
  assert.equal(result.code, "internal-deadline");
  assert.equal(result.elapsedMs, 10);
  assert.equal(result.admission, null);
});

test("a timely running observation may restart a transient acceptance API read until 34:30", async () => {
  const clock = createFakeClock();
  const logs = [];
  const { adapter } = createAdapter({
    clock,
    applications: ({ call }) => {
      if (call === 4) throw new Error("temporary preprobe API failure");
      return [application()];
    },
    instances: ({ call }) => [
      instance({ state: call < 3 ? "stopped" : "running" }),
    ],
  });
  const result = await runScenario({
    adapter,
    clock,
    logger: (line) => logs.push(line),
    config: {
      primaryAttempts: 2,
      primaryPollIntervalMs: 90,
      terminalPollIntervalMs: 40,
      transitionDeadlineMs: 100,
      acceptanceDeadlineMs: 200,
      wranglerCommandTimeoutMs: 50,
      warmupTimeoutMs: 50,
      probeTimeoutMs: 50,
    },
  });

  assert.equal(result.ready, true);
  assert.ok(clock.now() > 100, "the fresh transaction may finish after 33:00");
  assert.ok(clock.now() < 200, "the fresh transaction must finish by 34:30");
  assert.match(logs.join("\n"), /full transaction will restart/);
});

const probeFailures = [
  [
    "root HTTP status",
    { root: { status: 503, body: "" } },
    "root-probe-failed",
  ],
  [
    "health HTTP status",
    { health: { status: 503, body: JSON.stringify({ status: "ok" }) } },
    "health-probe-failed",
  ],
  [
    "health response body",
    { health: { status: 200, body: JSON.stringify({ status: "degraded" }) } },
    "health-probe-failed",
  ],
  [
    "anonymous status",
    {
      "anonymous-me": {
        status: 200,
        body: JSON.stringify({ error: "Sign in required" }),
      },
    },
    "anonymous-auth-probe-failed",
  ],
  [
    "anonymous response body",
    {
      "anonymous-me": {
        status: 401,
        body: JSON.stringify({ error: "different rejection" }),
      },
    },
    "anonymous-auth-probe-failed",
  ],
];

for (const [name, probes, expectedCode] of probeFailures) {
  test(`acceptance rejects a failed ${name} probe`, async () => {
    const clock = createFakeClock();
    const { adapter } = createAdapter({ clock, probes });
    const result = await runScenario({ adapter, clock, logger: () => {} });
    assert.equal(result.ready, false);
    assert.equal(result.code, expectedCode);
  });
}

test("a network error from every public probe fails closed", async (t) => {
  for (const kind of ["root", "health", "anonymous-me"]) {
    await t.test(kind, async () => {
      const clock = createFakeClock();
      const { adapter } = createAdapter({
        clock,
        probes: {
          [kind]: () => {
            throw new Error("network unavailable");
          },
        },
      });
      const result = await runScenario({ adapter, clock, logger: () => {} });
      assert.equal(result.ready, false);
      assert.equal(result.code, `${kind}-probe-failed`);
    });
  }
});

test("a bounded acceptance probe timeout fails closed", async () => {
  const clock = createFakeClock();
  const { adapter } = createAdapter({
    clock,
    probes: {
      root: ({ clock: fakeClock, timeoutMs }) => {
        fakeClock.advance(timeoutMs);
        throw new Error("public probe timeout");
      },
    },
  });
  const result = await runScenario({
    adapter,
    clock,
    logger: () => {},
    config: {
      transitionDeadlineMs: 100,
      acceptanceDeadlineMs: 200,
      wranglerCommandTimeoutMs: 10,
      warmupTimeoutMs: 10,
      probeTimeoutMs: 10,
    },
  });

  assert.equal(result.ready, false);
  assert.equal(result.code, "root-probe-failed");
  assert.equal(result.elapsedMs, 10);
});

const postprobeInstanceDivergences = [
  ["identity", { id: "instance-2" }],
  ["version", { version: 15 }],
  ["state", { state: "stopped" }],
];

for (const [name, overrides] of postprobeInstanceDivergences) {
  test(`acceptance rejects post-probe instance ${name} drift`, async () => {
    const clock = createFakeClock();
    const { adapter } = createAdapter({
      clock,
      instances: ({ call }) => [instance(call === 3 ? overrides : undefined)],
    });
    const result = await runScenario({ adapter, clock, logger: () => {} });
    assert.equal(result.ready, false);
    assert.equal(result.code, "postprobe-instance-mismatch");
  });
}

test("acceptance rejects a duplicate named post-probe instance", async () => {
  const clock = createFakeClock();
  const { adapter } = createAdapter({
    clock,
    instances: ({ call }) =>
      call === 3 ? [instance(), instance({ id: "instance-2" })] : [instance()],
  });
  const result = await runScenario({ adapter, clock, logger: () => {} });
  assert.equal(result.ready, false);
  assert.equal(result.code, "postprobe-instance-mismatch");
});

test("acceptance rejects application digest drift before probes", async () => {
  const clock = createFakeClock();
  const { adapter, calls } = createAdapter({
    clock,
    applications: ({ call }) => [
      application(
        call === 2
          ? {
              image: `registry.cloudflare.com/account/jack-core-production@${OTHER_DIGEST}`,
            }
          : undefined,
      ),
    ],
  });
  const result = await runScenario({ adapter, clock, logger: () => {} });
  assert.equal(result.ready, false);
  assert.equal(result.code, "application-drift");
  assert.equal(calls.probes.filter(({ kind }) => kind !== "warmup").length, 0);
});

test("acceptance rejects application version drift after probes", async () => {
  const clock = createFakeClock();
  const { adapter } = createAdapter({
    clock,
    applications: ({ call }) => [
      application(call === 3 ? { version: 15 } : undefined),
    ],
  });
  const result = await runScenario({ adapter, clock, logger: () => {} });
  assert.equal(result.ready, false);
  assert.equal(result.code, "postprobe-application-drift");
});

test("digest or version drift after stopped admission fails instead of re-admitting", async () => {
  const clock = createFakeClock();
  const { adapter } = createAdapter({
    clock,
    applications: ({ call }) => [
      application(
        call === 2
          ? {
              image: `registry.cloudflare.com/account/jack-core-production@${OTHER_DIGEST}`,
              version: 15,
            }
          : undefined,
      ),
    ],
    instances: [instance({ state: "stopped" })],
  });
  const result = await runScenario({
    adapter,
    clock,
    logger: () => {},
    config: { primaryAttempts: 2, primaryPollIntervalMs: 1 },
  });
  assert.equal(result.ready, false);
  assert.equal(result.code, "application-drift");
});

test("an initially running bounded Wrangler timeout retries before the absolute acceptance deadline", async () => {
  const clock = createFakeClock();
  const { adapter, calls } = createAdapter({
    clock,
    applications: ({ call, clock: fakeClock, timeoutMs }) => {
      if (call === 2) fakeClock.advance(timeoutMs + 1);
      return [application()];
    },
  });
  const result = await runScenario({
    adapter,
    clock,
    logger: () => {},
    config: {
      transitionDeadlineMs: 1_000,
      acceptanceDeadlineMs: 1_500,
      wranglerCommandTimeoutMs: 50,
      terminalPollIntervalMs: 1,
    },
  });
  assert.equal(result.ready, true);
  assert.equal(result.code, "accepted");
  assert.equal(result.elapsedMs, 52);
  assert.equal(calls.probes.filter(({ kind }) => kind === "root").length, 1);
});

test("the production subprocess adapter kills a command that exceeds its timeout", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    runBoundedCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      timeoutMs: 100,
    }),
    /exceeded its bounded 100ms subprocess window/,
  );
  assert.ok(Date.now() - startedAt < 2_000);
});

test(
  "a subprocess timeout settles without waiting for descendant-retained stdio",
  { skip: process.platform === "win32" },
  async () => {
    const descendantScript = `
      const { spawn } = require("node:child_process");
      const descendant = spawn(
        process.execPath,
        ["-e", "setTimeout(() => {}, 800)"],
        { detached: true, stdio: ["ignore", "inherit", "inherit"] },
      );
      descendant.unref();
      setInterval(() => {}, 1_000);
    `;
    const startedAt = Date.now();
    await assert.rejects(
      runBoundedCommand(process.execPath, ["-e", descendantScript], {
        timeoutMs: 100,
      }),
      /exceeded its bounded 100ms subprocess window/,
    );
    assert.ok(
      Date.now() - startedAt < 500,
      "the timeout must settle before the detached descendant closes inherited stdio",
    );
  },
);

test("the production adapter executes only the exact pinned Wrangler version", async () => {
  const calls = [];
  const runCommand = async (command, args, options) => {
    calls.push({ command, args, options });
    return "[]";
  };
  const adapter = createProductionRolloutAdapter({
    target: TARGET,
    runCommand,
  });

  await adapter.listApplications({ timeoutMs: 1_234 });
  await adapter.listInstances("app-1", { timeoutMs: 2_345 });

  assert.deepEqual(calls, [
    {
      command: "npx",
      args: [
        "--yes",
        `wrangler@${WRANGLER_VERSION}`,
        "containers",
        "list",
        "--per-page",
        "100",
        "--json",
      ],
      options: { timeoutMs: 1_234 },
    },
    {
      command: "npx",
      args: [
        "--yes",
        `wrangler@${WRANGLER_VERSION}`,
        "containers",
        "instances",
        "app-1",
        "--search",
        "jack-production",
        "--per-page",
        "100",
        "--json",
      ],
      options: { timeoutMs: 2_345 },
    },
  ]);
  assert.equal(WRANGLER_VERSION, "4.127.1");
});

test("the clock refuses a sleep that would reach or cross the transition deadline", async () => {
  const clock = createFakeClock();
  const { adapter } = createAdapter({
    clock,
    instances: [instance({ state: "stopped" })],
  });
  const result = await runScenario({
    adapter,
    clock,
    logger: () => {},
    config: {
      primaryAttempts: 2,
      primaryPollIntervalMs: 950,
      terminalPollIntervalMs: 100,
      transitionDeadlineMs: 1_000,
      acceptanceDeadlineMs: 1_500,
    },
  });
  assert.equal(result.ready, false);
  assert.equal(result.code, "transition-deadline");
  assert.equal(clock.now(), 950);
  assert.deepEqual(clock.sleeps, [{ from: 0, delayMs: 950, to: 950 }]);
});

test("failure logs monotonic elapsed time and a final structured snapshot", async () => {
  const clock = createFakeClock();
  const logs = [];
  const { adapter } = createAdapter({
    clock,
    applications: [application({ state: "deploying" })],
  });
  const result = await runScenario({
    adapter,
    clock,
    logger: (line) => logs.push(line),
    config: { primaryAttempts: 1 },
  });
  assert.equal(result.ready, false);
  assert.match(logs.at(-2), /ready=false.*elapsed=0\.000s/);
  assert.match(logs.at(-1), /rollout final snapshot: \{"phase":"failed"/);
});

test("no incomplete predicate can set ready", async (t) => {
  const scenarios = [
    {
      name: "non-running preprobe instance",
      instances: ({ call }) => [
        instance(call === 2 ? { state: "stopped" } : undefined),
      ],
    },
    {
      name: "postprobe application digest drift",
      applications: ({ call }) => [
        application(
          call === 3
            ? {
                image: `registry.cloudflare.com/account/jack-core-production@${OTHER_DIGEST}`,
              }
            : undefined,
        ),
      ],
    },
    {
      name: "postprobe instance mismatch",
      instances: ({ call }) => [
        instance(call === 3 ? { id: "replacement" } : undefined),
      ],
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const clock = createFakeClock();
      const { adapter } = createAdapter({ clock, ...scenario });
      const result = await runScenario({ adapter, clock, logger: () => {} });
      assert.equal(result.ready, false);
    });
  }
});
