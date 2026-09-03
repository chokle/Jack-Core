#!/usr/bin/env node

import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { runRolloutAcceptance } from "./rollout-acceptance.mjs";

export const WRANGLER_VERSION = "4.127.1";
export const PRODUCTION_PRIMARY_ATTEMPTS = 240;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function killProcessTree(child) {
  if (!child.pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // The child may have exited between the timeout and the signal.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // The child is already gone.
  }
}

export function runBoundedCommand(command, args, { timeoutMs }) {
  const boundedTimeoutMs = Math.max(1, Math.floor(timeoutMs));
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: process.platform !== "win32",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;

    const releaseCapturedHandles = () => {
      for (const stream of [child.stdout, child.stderr]) {
        stream?.destroy();
        stream?.unref?.();
      }
      child.unref();
    };

    const settle = (callback, value, { releaseHandles = false } = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (releaseHandles) releaseCapturedHandles();
      callback(value);
    };

    const failAndRelease = (error) => {
      killProcessTree(child);
      settle(reject, error, { releaseHandles: true });
    };

    timer = setTimeout(() => {
      failAndRelease(
        new Error(
          `${command} exceeded its bounded ${boundedTimeoutMs}ms subprocess window.`,
        ),
      );
    }, boundedTimeoutMs);

    const collect = (stream, assign) => {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        assign(chunk);
        if (
          !settled &&
          Buffer.byteLength(stdout) + Buffer.byteLength(stderr) >
            MAX_OUTPUT_BYTES
        ) {
          failAndRelease(
            new Error(`${command} exceeded its bounded output buffer.`),
          );
        }
      });
    };
    collect(child.stdout, (chunk) => {
      stdout += chunk;
    });
    collect(child.stderr, (chunk) => {
      stderr += chunk;
    });

    child.once("error", (error) => {
      settle(reject, error);
    });
    child.once("close", (code, signal) => {
      if (code !== 0) {
        settle(
          reject,
          new Error(
            `${command} exited ${code ?? `via ${signal ?? "unknown signal"}`}: ${stderr.trim()}`,
          ),
        );
        return;
      }
      settle(resolve, stdout);
    });
  });
}

function parseWranglerJson(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`${label} did not return valid JSON.`);
  }
}

export function createProductionRolloutAdapter({
  target,
  runCommand = runBoundedCommand,
  freshControlPlaneReads = false,
}) {
  const baseUrl = new URL(target);

  const wranglerJson = async (args, { timeoutMs, label }) => {
    const stdout = await runCommand(
      "npx",
      ["--yes", `wrangler@${WRANGLER_VERSION}`, ...args],
      { timeoutMs },
    );
    return parseWranglerJson(stdout, label);
  };

  return {
    listApplications: ({ timeoutMs }) =>
      wranglerJson(
        freshControlPlaneReads
          ? ["containers", "list", "--json"]
          : ["containers", "list", "--per-page", "100", "--json"],
        {
          timeoutMs,
          label: "Wrangler application read",
        },
      ),
    listInstances: (applicationId, { timeoutMs }) =>
      wranglerJson(
        freshControlPlaneReads
          ? ["containers", "instances", applicationId, "--json"]
          : [
              "containers",
              "instances",
              applicationId,
              "--search",
              "jack-production",
              "--per-page",
              "100",
              "--json",
            ],
        {
          timeoutMs,
          label: "Wrangler instance read",
        },
      ),
    probe: async ({ path, phase, release, attempt, timeoutMs }) => {
      const url = new URL(path, baseUrl);
      url.searchParams.set("release", release);
      url.searchParams.set("attempt", String(attempt));
      url.searchParams.set("phase", phase);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          headers: { "Cache-Control": "no-cache" },
          redirect: "manual",
          signal: controller.signal,
        });
        const body = await response.text();
        return { status: response.status, body };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export async function main() {
  const target = process.env.CLOUDFLARE_ROLLOUT_TARGET ?? "";
  const release = process.env.CLOUDFLARE_ROLLOUT_RELEASE ?? "";
  const expectedDigest = process.env.CLOUDFLARE_EXPECTED_DIGEST ?? "";
  const result = await runRolloutAcceptance({
    target,
    release,
    expectedDigest,
    adapter: createProductionRolloutAdapter({
      target,
      freshControlPlaneReads: true,
    }),
    config: { primaryAttempts: PRODUCTION_PRIMARY_ATTEMPTS },
  });
  if (!result.ready) {
    console.error(`::error::Cloudflare rollout rejected: ${result.message}`);
    process.exitCode = 1;
  }
}

const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entryUrl === import.meta.url) {
  main().catch((error) => {
    console.error(`::error::Cloudflare rollout gate failed: ${error.message}`);
    process.exitCode = 1;
  });
}
