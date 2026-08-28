import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Cloudflare production uses the supported Container readiness lifecycle", async () => {
  const [packageText, worker] = await Promise.all([
    read("package.json"),
    read("cloudflare/worker.mjs"),
  ]);
  const pkg = JSON.parse(packageText);

  assert.equal(pkg.dependencies?.["@cloudflare/containers"], "0.3.7");
  assert.match(
    worker,
    /import \{ Container, getContainer \} from "@cloudflare\/containers"/,
  );
  assert.match(worker, /const CONTAINER_PORT = 8080/);
  assert.match(worker, /class JackProductionContainer extends Container/);
  assert.match(worker, /defaultPort = CONTAINER_PORT/);
  assert.match(worker, /requiredPorts = \[CONTAINER_PORT\]/);
  assert.match(worker, /sleepAfter = "10m"/);
  assert.match(worker, /pingEndpoint = "localhost\/api\/healthz"/);
  assert.match(worker, /this\.envVars = containerEnv\(env\)/);
  assert.match(
    worker,
    /getContainer\(env\.JACK_CONTAINER, CONTAINER_NAME\)\.fetch\(request\)/,
  );

  assert.doesNotMatch(worker, /getTcpPort/);
  assert.doesNotMatch(worker, /ctx\.container\.start/);
  assert.doesNotMatch(worker, /STARTUP_RETRIES|STARTUP_RETRY_MS/);
});
