import assert from "node:assert/strict";
import test from "node:test";

import { ROLLOUT_DEFAULTS } from "./rollout-acceptance.mjs";
import { PRODUCTION_PRIMARY_ATTEMPTS } from "./run-rollout-acceptance.mjs";

test("production rollout runner cannot exhaust its poll count before the transition deadline", () => {
  assert.equal(PRODUCTION_PRIMARY_ATTEMPTS, 240);
  assert.ok(
    PRODUCTION_PRIMARY_ATTEMPTS * ROLLOUT_DEFAULTS.primaryPollIntervalMs >
      ROLLOUT_DEFAULTS.transitionDeadlineMs,
  );
});
