import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ROLLOUT_DEFAULTS } from "./rollout-acceptance.mjs";

test("production rollout runner cannot exhaust its poll count before the transition deadline", () => {
  const source = readFileSync(
    new URL("./run-rollout-acceptance.mjs", import.meta.url),
    "utf8",
  );

  assert.match(source, /config:\s*\{\s*primaryAttempts:\s*240\s*\}/);
  assert.ok(
    240 * ROLLOUT_DEFAULTS.primaryPollIntervalMs >
      ROLLOUT_DEFAULTS.transitionDeadlineMs,
  );
});
