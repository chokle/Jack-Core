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
const pilotAuthBypass = process.env.PILOT_AUTH_BYPASS !== "false";
const supabaseUrl =
  process.env.SUPABASE_URL || "https://mdqdswhzkocglbnxvxth.supabase.co";

if (
  !pilotAuthBypass &&
  (!publishableKey || !/^pk_(?:live|test)_/.test(publishableKey))
) {
  throw new Error(
    "VITE_CLERK_PUBLISHABLE_KEY (or CLERK_PUBLISHABLE_KEY) is required when pilot auth bypass is disabled.",
  );
}

const config = JSON.parse(await readFile(sourcePath, "utf8"));
config.vars = {
  ...config.vars,
  SUPABASE_URL: supabaseUrl,
  PILOT_AUTH_BYPASS: pilotAuthBypass ? "true" : "false",
  PILOT_AUTH_USER_ID: process.env.PILOT_AUTH_USER_ID || "pilot001-bypass",
  PILOT_AUTH_EMAIL:
    process.env.PILOT_AUTH_EMAIL || "pilot001-bypass@torchlabs.ca",
  PILOT_AUTH_NAME: process.env.PILOT_AUTH_NAME || "Pilot001",
  PILOT_AUTH_ADMIN: process.env.PILOT_AUTH_ADMIN || "true",
  ...(publishableKey ? { CLERK_PUBLISHABLE_KEY: publishableKey } : {}),
};
config.secrets = {
  required: ["SUPABASE_SERVICE_ROLE_KEY", "OPENAI_API_KEY"],
};
config.containers = config.containers.map((container) => ({
  ...container,
  image_vars: {
    ...(container.image_vars || {}),
    BASE_PATH: "/",
    PUBLIC_SITE_URL: "https://jack.torchlabs.ca",
    SUPABASE_URL: supabaseUrl,
    ...(publishableKey ? { VITE_CLERK_PUBLISHABLE_KEY: publishableKey } : {}),
    VITE_PILOT_AUTH_BYPASS: pilotAuthBypass ? "true" : "false",
    PILOT_AUTH_BYPASS: pilotAuthBypass ? "true" : "false",
    PILOT_AUTH_USER_ID: process.env.PILOT_AUTH_USER_ID || "pilot001-bypass",
    PILOT_AUTH_EMAIL:
      process.env.PILOT_AUTH_EMAIL || "pilot001-bypass@torchlabs.ca",
    PILOT_AUTH_NAME: process.env.PILOT_AUTH_NAME || "Pilot001",
    PILOT_AUTH_ADMIN: process.env.PILOT_AUTH_ADMIN || "true",
    VITE_DISABLE_CLERK_PROXY: "true",
    VITE_ENABLE_CLERK_PROXY: "false",
  },
}));

await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
console.log(outputPath);
