import assert from "node:assert/strict";
import test from "node:test";
import {
  createProductionRolloutAdapter,
  WRANGLER_VERSION,
} from "./run-rollout-acceptance.mjs";

const TARGET = "https://jack-core-production.example.workers.dev";

test("fresh production control-plane reads use the plain Wrangler JSON path", async () => {
  const calls = [];
  const runCommand = async (command, args, options) => {
    calls.push({ command, args, options });
    return "[]";
  };
  const adapter = createProductionRolloutAdapter({
    target: TARGET,
    runCommand,
    freshControlPlaneReads: true,
  });

  await adapter.listApplications({ timeoutMs: 1_000 });
  await adapter.listInstances("app-1", { timeoutMs: 1_000 });

  assert.deepEqual(calls, [
    {
      command: "npx",
      args: [
        "--yes",
        `wrangler@${WRANGLER_VERSION}`,
        "containers",
        "list",
        "--json",
      ],
      options: { timeoutMs: 1_000 },
    },
    {
      command: "npx",
      args: [
        "--yes",
        `wrangler@${WRANGLER_VERSION}`,
        "containers",
        "instances",
        "app-1",
        "--json",
      ],
      options: { timeoutMs: 1_000 },
    },
  ]);

  const flattened = calls.flatMap(({ args }) => args);
  assert.equal(flattened.includes("--per-page"), false);
  assert.equal(flattened.includes("--search"), false);
});
