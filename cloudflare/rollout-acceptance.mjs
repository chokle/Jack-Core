import { performance } from "node:perf_hooks";

export const ROLLOUT_DEFAULTS = Object.freeze({
  primaryAttempts: 120,
  primaryPollIntervalMs: 10_000,
  terminalPollIntervalMs: 10_000,
  transitionDeadlineMs: 33 * 60_000,
  acceptanceDeadlineMs: 34.5 * 60_000,
  wranglerCommandTimeoutMs: 30_000,
  warmupTimeoutMs: 30_000,
  probeTimeoutMs: 15_000,
});

const APPLICATION_NAME = "jack-core-production";
const INSTANCE_NAME = "jack-production";
const ACCEPTED_APPLICATION_STATES = new Set(["active", "ready"]);

class GateFailure extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GateFailure";
    this.code = code;
  }
}

class OperationTimeout extends Error {
  constructor(message) {
    super(message);
    this.name = "OperationTimeout";
  }
}

export function createMonotonicClock() {
  return {
    now: () => performance.now(),
    sleep: (delayMs) =>
      new Promise((resolve) => {
        setTimeout(resolve, delayMs);
      }),
  };
}

function asNonEmptyString(value) {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  return text;
}

function rowsFrom(payload, keys) {
  const parsed =
    typeof payload === "string" && payload.trim()
      ? JSON.parse(payload)
      : payload;
  if (Array.isArray(parsed)) return parsed;
  for (const key of keys) {
    if (Array.isArray(parsed?.[key])) return parsed[key];
  }
  throw new Error("Cloudflare response did not contain an array.");
}

function digestFromImage(image) {
  const text = asNonEmptyString(image);
  const match = text.match(/(?:^|@)(sha256:[0-9a-f]{64})$/i);
  return match?.[1]?.toLowerCase() ?? "";
}

function summarizeApplication(payload, expectedDigest) {
  const rows = rowsFrom(payload, ["result", "applications"]);
  const matches = rows.filter((row) => row?.name === APPLICATION_NAME);
  const row = matches.length === 1 ? matches[0] : null;
  const application = {
    namedCount: matches.length,
    id: asNonEmptyString(row?.id ?? row?.application_id),
    state: asNonEmptyString(row?.state),
    digest: digestFromImage(row?.image),
    version: asNonEmptyString(row?.version),
  };
  application.exact =
    application.namedCount === 1 &&
    application.id !== "" &&
    application.version !== "" &&
    ACCEPTED_APPLICATION_STATES.has(application.state) &&
    application.digest === expectedDigest;
  return application;
}

function summarizeInstance(payload, applicationVersion) {
  const rows = rowsFrom(payload, ["instances"]);
  const matches = rows.filter((row) => row?.name === INSTANCE_NAME);
  const row = matches.length === 1 ? matches[0] : null;
  const instance = {
    namedCount: matches.length,
    id: asNonEmptyString(row?.id ?? row?.instance_id),
    state: asNonEmptyString(row?.state),
    version: asNonEmptyString(row?.version),
  };
  instance.identityVersionMatch =
    instance.namedCount === 1 &&
    instance.id !== "" &&
    applicationVersion !== "" &&
    instance.version === applicationVersion;
  return instance;
}

function parseJsonBody(body) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function formatElapsed(elapsedMs) {
  return `${(elapsedMs / 1000).toFixed(3)}s`;
}

function newSnapshot() {
  return {
    phase: "initializing",
    primaryAttempt: 0,
    terminalPoll: 0,
    elapsedMs: 0,
    application: null,
    warmup: null,
    instance: null,
    probes: {
      root: null,
      health: null,
      anonymousMe: null,
    },
    postprobeApplication: null,
    postprobeInstance: null,
    transientError: null,
  };
}

function pinnedApplicationMatches(application, admission) {
  return (
    application.exact &&
    application.id === admission.applicationId &&
    application.digest === admission.digest &&
    application.version === admission.applicationVersion
  );
}

function pinnedInstanceMatches(instance, admission, state) {
  return (
    instance.identityVersionMatch &&
    instance.id === admission.instanceId &&
    instance.version === admission.instanceVersion &&
    instance.state === state
  );
}

export async function runRolloutAcceptance({
  target,
  release,
  expectedDigest,
  adapter,
  clock = createMonotonicClock(),
  logger = console.log,
  config = {},
}) {
  const options = { ...ROLLOUT_DEFAULTS, ...config };
  if (!adapter) throw new TypeError("A rollout adapter is required.");
  if (
    !clock ||
    typeof clock.now !== "function" ||
    typeof clock.sleep !== "function"
  ) {
    throw new TypeError(
      "A monotonic clock with now() and sleep() is required.",
    );
  }
  if (!target || !release) {
    throw new TypeError("The rollout target and release are required.");
  }
  const normalizedDigest = asNonEmptyString(expectedDigest).toLowerCase();
  if (!/^sha256:[0-9a-f]{64}$/.test(normalizedDigest)) {
    throw new TypeError("The expected container digest is invalid.");
  }
  if (
    !Number.isInteger(options.primaryAttempts) ||
    options.primaryAttempts < 1 ||
    options.primaryPollIntervalMs < 0 ||
    options.terminalPollIntervalMs < 0 ||
    options.transitionDeadlineMs <= 0 ||
    options.acceptanceDeadlineMs <= options.transitionDeadlineMs ||
    options.wranglerCommandTimeoutMs <= 0 ||
    options.warmupTimeoutMs <= 0 ||
    options.probeTimeoutMs <= 0
  ) {
    throw new TypeError("The rollout timing configuration is invalid.");
  }

  const startedAt = clock.now();
  const transitionDeadline = startedAt + options.transitionDeadlineMs;
  const acceptanceDeadline = startedAt + options.acceptanceDeadlineMs;
  let admission = null;
  let snapshot = newSnapshot();

  const elapsed = () => Math.max(0, clock.now() - startedAt);

  const updateElapsed = () => {
    snapshot.elapsedMs = elapsed();
  };

  const logSnapshot = (label) => {
    updateElapsed();
    logger(
      `workers.dev rollout ${label}: elapsed=${formatElapsed(snapshot.elapsedMs)} snapshot=${JSON.stringify(snapshot)}`,
    );
  };

  const finish = (ready, code, message) => {
    updateElapsed();
    snapshot.phase = ready ? "accepted" : "failed";
    logger(
      `workers.dev rollout final: ready=${ready} code=${code} elapsed=${formatElapsed(snapshot.elapsedMs)} message=${message}`,
    );
    logger(`workers.dev rollout final snapshot: ${JSON.stringify(snapshot)}`);
    return {
      ready,
      code,
      message,
      elapsedMs: snapshot.elapsedMs,
      admission,
      snapshot,
    };
  };

  const callBounded = async ({ label, deadline, timeoutCapMs, operation }) => {
    const before = clock.now();
    const remainingMs = deadline - before;
    if (remainingMs <= 0) {
      throw new GateFailure(
        "internal-deadline",
        `${label} could not start before its internal deadline.`,
      );
    }
    const timeoutMs = Math.max(
      1,
      Math.floor(Math.min(timeoutCapMs, remainingMs)),
    );
    let value;
    try {
      value = await operation(timeoutMs);
    } catch (error) {
      const after = clock.now();
      if (after >= deadline) {
        throw new GateFailure(
          "internal-deadline",
          `${label} reached its absolute phase deadline.`,
        );
      }
      if (after - before >= timeoutMs) {
        throw new OperationTimeout(
          `${label} exceeded its bounded ${timeoutMs}ms operation window.`,
        );
      }
      throw error;
    }
    const after = clock.now();
    if (after > deadline) {
      throw new GateFailure(
        "internal-deadline",
        `${label} crossed its absolute phase deadline.`,
      );
    }
    if (after - before > timeoutMs) {
      throw new OperationTimeout(
        `${label} exceeded its bounded ${timeoutMs}ms operation window.`,
      );
    }
    return value;
  };

  const readApplication = async (deadline) => {
    const payload = await callBounded({
      label: "Wrangler application read",
      deadline,
      timeoutCapMs: options.wranglerCommandTimeoutMs,
      operation: (timeoutMs) => adapter.listApplications({ timeoutMs }),
    });
    return summarizeApplication(payload, normalizedDigest);
  };

  const readInstance = async (applicationId, applicationVersion, deadline) => {
    const payload = await callBounded({
      label: "Wrangler instance read",
      deadline,
      timeoutCapMs: options.wranglerCommandTimeoutMs,
      operation: (timeoutMs) =>
        adapter.listInstances(applicationId, { timeoutMs }),
    });
    return summarizeInstance(payload, applicationVersion);
  };

  const probe = async ({
    kind,
    path,
    phase,
    timeoutMs,
    deadline,
    attempt,
    retryTransportFailure = false,
  }) => {
    try {
      return await callBounded({
        label: `${kind} probe`,
        deadline,
        timeoutCapMs: timeoutMs,
        operation: (boundedTimeoutMs) =>
          adapter.probe({
            kind,
            path,
            phase,
            release,
            attempt,
            timeoutMs: boundedTimeoutMs,
          }),
      });
    } catch (error) {
      if (error instanceof GateFailure) {
        throw error;
      } else if (retryTransportFailure) {
        throw error;
      }
      throw new GateFailure(
        `${kind}-probe-failed`,
        `${kind} probe failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const sleepBefore = async (delayMs, deadline, phase) => {
    if (delayMs === 0) return true;
    const before = clock.now();
    if (before + delayMs >= deadline) {
      logger(
        `workers.dev rollout ${phase}: refusing ${delayMs}ms sleep at elapsed=${formatElapsed(elapsed())}; it would reach or cross the internal deadline.`,
      );
      return false;
    }
    await clock.sleep(delayMs);
    if (clock.now() > deadline) {
      throw new GateFailure(
        "internal-deadline",
        `${phase} sleep crossed its internal deadline.`,
      );
    }
    return true;
  };

  const completeAcceptance = async (candidate, transitionObservedAt) => {
    snapshot.phase = "acceptance-transaction";
    snapshot.transientError = null;
    snapshot.probes = {
      root: null,
      health: null,
      anonymousMe: null,
    };
    snapshot.postprobeApplication = null;
    snapshot.postprobeInstance = null;
    if (transitionObservedAt > transitionDeadline) {
      throw new GateFailure(
        "transition-deadline",
        "The serving instance transitioned after the 33-minute deadline.",
      );
    }

    const transactionAdmission = admission ?? {
      admittedAtMs: elapsed(),
      applicationId: candidate.application.id,
      digest: candidate.application.digest,
      applicationVersion: candidate.application.version,
      instanceId: candidate.instance.id,
      instanceVersion: candidate.instance.version,
    };

    const preprobeApplication = await readApplication(acceptanceDeadline);
    snapshot.application = preprobeApplication;
    if (!pinnedApplicationMatches(preprobeApplication, transactionAdmission)) {
      throw new GateFailure(
        "application-drift",
        "Application identity, digest, state, or version changed before acceptance probes.",
      );
    }

    const preprobeInstance = await readInstance(
      preprobeApplication.id,
      preprobeApplication.version,
      acceptanceDeadline,
    );
    snapshot.instance = preprobeInstance;
    if (
      !pinnedInstanceMatches(preprobeInstance, transactionAdmission, "running")
    ) {
      throw new GateFailure(
        "preprobe-instance-mismatch",
        "The unique named serving instance did not preserve its pinned running identity and version before probes.",
      );
    }

    const root = await probe({
      kind: "root",
      path: "/",
      phase: "acceptance",
      timeoutMs: options.probeTimeoutMs,
      deadline: acceptanceDeadline,
      attempt: snapshot.primaryAttempt || snapshot.terminalPoll,
    });
    snapshot.probes.root = { status: root.status };
    if (root.status !== 200) {
      throw new GateFailure(
        "root-probe-failed",
        `The public shell returned ${root.status ?? "unavailable"}, not 200.`,
      );
    }

    const health = await probe({
      kind: "health",
      path: "/api/healthz",
      phase: "acceptance",
      timeoutMs: options.probeTimeoutMs,
      deadline: acceptanceDeadline,
      attempt: snapshot.primaryAttempt || snapshot.terminalPoll,
    });
    const healthBody = parseJsonBody(health.body);
    const healthOk = health.status === 200 && healthBody?.status === "ok";
    snapshot.probes.health = { status: health.status, bodyOk: healthOk };
    if (!healthOk) {
      throw new GateFailure(
        "health-probe-failed",
        "The health probe did not return HTTP 200 with status=ok.",
      );
    }

    const anonymousMe = await probe({
      kind: "anonymous-me",
      path: "/api/me",
      phase: "acceptance",
      timeoutMs: options.probeTimeoutMs,
      deadline: acceptanceDeadline,
      attempt: snapshot.primaryAttempt || snapshot.terminalPoll,
    });
    const anonymousBody = parseJsonBody(anonymousMe.body);
    const anonymousOk =
      anonymousMe.status === 401 &&
      String(anonymousBody?.error ?? "")
        .toLowerCase()
        .includes("sign in required");
    snapshot.probes.anonymousMe = {
      status: anonymousMe.status,
      bodyOk: anonymousOk,
    };
    if (!anonymousOk) {
      throw new GateFailure(
        "anonymous-auth-probe-failed",
        "Anonymous /api/me did not return the exact fail-closed 401 response.",
      );
    }

    const postprobeApplication = await readApplication(acceptanceDeadline);
    snapshot.postprobeApplication = postprobeApplication;
    if (!pinnedApplicationMatches(postprobeApplication, transactionAdmission)) {
      throw new GateFailure(
        "postprobe-application-drift",
        "Application identity, digest, state, or version changed during acceptance probes.",
      );
    }

    const postprobeInstance = await readInstance(
      postprobeApplication.id,
      postprobeApplication.version,
      acceptanceDeadline,
    );
    snapshot.postprobeInstance = postprobeInstance;
    if (
      !pinnedInstanceMatches(postprobeInstance, transactionAdmission, "running")
    ) {
      throw new GateFailure(
        "postprobe-instance-mismatch",
        "The unique named serving instance did not preserve its pinned running identity and version after probes.",
      );
    }

    if (clock.now() > acceptanceDeadline) {
      throw new GateFailure(
        "acceptance-deadline",
        "The complete acceptance transaction finished after 34 minutes 30 seconds.",
      );
    }
    admission = transactionAdmission;
    return finish(
      true,
      "accepted",
      "Exact application and serving-instance identity survived the complete public acceptance transaction.",
    );
  };

  const completeAcceptanceWithRetries = async (
    candidate,
    transitionObservedAt,
    allowTransientApiRetry,
  ) => {
    while (clock.now() <= acceptanceDeadline) {
      try {
        return await completeAcceptance(candidate, transitionObservedAt);
      } catch (error) {
        if (error instanceof GateFailure || !allowTransientApiRetry) {
          throw error;
        }
        snapshot.transientError =
          error instanceof Error ? error.message : String(error);
        logger(
          `workers.dev rollout acceptance transient API read: elapsed=${formatElapsed(elapsed())} error=${snapshot.transientError}; the full transaction will restart and stale evidence cannot be accepted.`,
        );
        if (
          !(await sleepBefore(
            options.terminalPollIntervalMs,
            acceptanceDeadline,
            "acceptance",
          ))
        ) {
          throw new GateFailure(
            "acceptance-deadline",
            "A fresh complete acceptance transaction could not finish by 34 minutes 30 seconds.",
          );
        }
      }
    }
    throw new GateFailure(
      "acceptance-deadline",
      "A fresh complete acceptance transaction did not finish by 34 minutes 30 seconds.",
    );
  };

  const handleFailure = (error, fallbackCode) => {
    const code = error instanceof GateFailure ? error.code : fallbackCode;
    const message = error instanceof Error ? error.message : String(error);
    return finish(false, code, message);
  };

  for (let attempt = 1; attempt <= options.primaryAttempts; attempt += 1) {
    snapshot = newSnapshot();
    snapshot.phase = "primary";
    snapshot.primaryAttempt = attempt;

    try {
      const application = await readApplication(transitionDeadline);
      snapshot.application = application;

      if (admission && !pinnedApplicationMatches(application, admission)) {
        throw new GateFailure(
          "application-drift",
          "Application identity, digest, state, or version changed after terminal admission.",
        );
      }

      if (application.exact) {
        const warmup = await probe({
          kind: "warmup",
          path: "/",
          phase: "warmup",
          timeoutMs: options.warmupTimeoutMs,
          deadline: transitionDeadline,
          attempt,
          retryTransportFailure: true,
        });
        snapshot.warmup = { status: warmup.status };

        if (warmup.status === 200) {
          const instance = await readInstance(
            application.id,
            application.version,
            transitionDeadline,
          );
          snapshot.instance = instance;

          if (admission) {
            const allowedState =
              instance.state === "stopped" || instance.state === "running";
            if (
              !allowedState ||
              !pinnedInstanceMatches(instance, admission, instance.state)
            ) {
              throw new GateFailure(
                "instance-drift",
                "The named instance identity, version, or admissible state changed after terminal admission.",
              );
            }
          }

          if (instance.identityVersionMatch && instance.state === "running") {
            logSnapshot(`primary ${attempt}/${options.primaryAttempts}`);
            return await completeAcceptanceWithRetries(
              { application, instance },
              clock.now(),
              Boolean(admission),
            );
          }

          if (
            !admission &&
            instance.identityVersionMatch &&
            instance.state === "stopped"
          ) {
            admission = {
              admittedAtMs: elapsed(),
              applicationId: application.id,
              digest: application.digest,
              applicationVersion: application.version,
              instanceId: instance.id,
              instanceVersion: instance.version,
            };
            logger(
              `workers.dev rollout terminal admission: elapsed=${formatElapsed(elapsed())} application=${application.id}@${application.version} instance=${instance.id}@${instance.version}`,
            );
          }
        }
      }
    } catch (error) {
      if (error instanceof GateFailure) {
        return handleFailure(error, "primary-failed");
      }
      if (snapshot.phase === "acceptance-transaction" && !admission) {
        return handleFailure(error, "acceptance-read-failed");
      }
      snapshot.transientError =
        error instanceof Error ? error.message : String(error);
      if (admission) {
        logger(
          `workers.dev rollout primary transient read after admission: elapsed=${formatElapsed(elapsed())} error=${snapshot.transientError}`,
        );
      }
    }

    logSnapshot(`primary ${attempt}/${options.primaryAttempts}`);
    if (attempt < options.primaryAttempts) {
      try {
        if (
          !(await sleepBefore(
            options.primaryPollIntervalMs,
            transitionDeadline,
            "primary",
          ))
        ) {
          return finish(
            false,
            "transition-deadline",
            "The next primary poll could not begin before the 33-minute transition deadline.",
          );
        }
      } catch (error) {
        return handleFailure(error, "primary-sleep-failed");
      }
    }
  }

  if (!admission) {
    return finish(
      false,
      "primary-exhausted-without-terminal-admission",
      `The ${options.primaryAttempts}-attempt primary window ended without an exact stopped-instance terminal admission snapshot.`,
    );
  }

  snapshot = newSnapshot();
  snapshot.phase = "terminal-reconciliation";
  snapshot.primaryAttempt = options.primaryAttempts;
  logger(
    `workers.dev rollout terminal reconciliation: primary attempts exhausted; transition must be observed by 33:00 and full acceptance must finish by 34:30.`,
  );

  let terminalPoll = 0;
  while (clock.now() <= transitionDeadline) {
    terminalPoll += 1;
    snapshot = newSnapshot();
    snapshot.phase = "terminal-reconciliation";
    snapshot.primaryAttempt = options.primaryAttempts;
    snapshot.terminalPoll = terminalPoll;
    try {
      const application = await readApplication(transitionDeadline);
      snapshot.application = application;
      if (!pinnedApplicationMatches(application, admission)) {
        throw new GateFailure(
          "application-drift",
          "Application identity, digest, state, or version changed during terminal reconciliation.",
        );
      }

      const instance = await readInstance(
        application.id,
        application.version,
        transitionDeadline,
      );
      snapshot.instance = instance;
      const allowedState =
        instance.state === "stopped" || instance.state === "running";
      if (
        !allowedState ||
        !pinnedInstanceMatches(instance, admission, instance.state)
      ) {
        throw new GateFailure(
          "instance-drift",
          "The named instance identity, version, or admissible state changed during terminal reconciliation.",
        );
      }

      if (instance.state === "running") {
        const observedAt = clock.now();
        logSnapshot(`terminal ${snapshot.terminalPoll}`);
        return await completeAcceptanceWithRetries(
          { application, instance },
          observedAt,
          true,
        );
      }
    } catch (error) {
      if (error instanceof GateFailure) {
        return handleFailure(error, "terminal-failed");
      }
      snapshot.transientError =
        error instanceof Error ? error.message : String(error);
      logger(
        `workers.dev rollout terminal transient read: elapsed=${formatElapsed(elapsed())} error=${snapshot.transientError}; stale admission cannot be accepted.`,
      );
    }

    logSnapshot(`terminal ${snapshot.terminalPoll}`);
    try {
      if (
        !(await sleepBefore(
          options.terminalPollIntervalMs,
          transitionDeadline,
          "terminal",
        ))
      ) {
        break;
      }
    } catch (error) {
      return handleFailure(error, "terminal-sleep-failed");
    }
  }

  return finish(
    false,
    "transition-deadline",
    "The pinned named instance was not freshly observed running by the 33-minute transition deadline.",
  );
}
