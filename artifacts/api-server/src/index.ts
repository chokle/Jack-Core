import app from "./app";
import { logger } from "./lib/logger";
import { startJobSystem } from "./lib/jobs";
import { startVitalitySampler } from "./lib/vitality";
import { startFeedbackNotificationWorker } from "./lib/feedback-notifications";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Recover any jobs stranded by a previous process life BEFORE accepting new
// work, then keep a runtime watchdog sweeping for stale/hung jobs.
startJobSystem();
startFeedbackNotificationWorker();

// Begin sampling CPU/RAM for the Systems Health heartbeat. Started here (not on
// import) so importing the vitality module in tests never spins up a timer.
startVitalitySampler();

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
