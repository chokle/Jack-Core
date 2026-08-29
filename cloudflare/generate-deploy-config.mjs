import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(here, "wrangler.base.json");
const outputPath = path.join(here, "wrangler.generated.json");

const publishableKey =
  process.env.VITE_CLERK_PUBLISHABLE_KEY ||
  process.env.CLERK_PUBLISHABLE_KEY ||
  "";

// Pilot 002 runs without participant authentication. Keep a stable synthetic
// participant id so telemetry remains attributable without collecting PII.
const pilotAuthBypass = true;
const pilotAuthUserId = "pilot002-nick";

const config = JSON.parse(await readFile(sourcePath, "utf8"));
config.vars = {
  ...config.vars,
  PILOT_AUTH_BYPASS: "true",
  PILOT_AUTH_USER_ID: pilotAuthUserId,
  ...(publishableKey ? { CLERK_PUBLISHABLE_KEY: publishableKey } : {}),
};
config.containers = config.containers.map((container) => ({
  ...container,
  image_vars: {
    ...(container.image_vars || {}),
    BASE_PATH: "/",
    PUBLIC_SITE_URL: "https://jack.torchlabs.ca",
    ...(publishableKey ? { VITE_CLERK_PUBLISHABLE_KEY: publishableKey } : {}),
    VITE_PILOT_AUTH_BYPASS: "true",
    PILOT_AUTH_BYPASS: "true",
    PILOT_AUTH_USER_ID: pilotAuthUserId,
    VITE_DISABLE_CLERK_PROXY: "true",
    VITE_ENABLE_CLERK_PROXY: "false",
  },
}));

await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
console.log(outputPath);
