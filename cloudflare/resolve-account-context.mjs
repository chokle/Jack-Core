import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const CLOUDFLARE_API_ROOT = "https://api.cloudflare.com/client/v4";

export async function resolveCloudflareAccountId({
  token,
  configuredAccountId = "",
  zoneName = "torchlabs.ca",
  fetchImpl = fetch,
}) {
  if (!token) {
    throw new Error("Missing required Cloudflare API token.");
  }

  const configured = configuredAccountId.trim();
  if (configured) {
    return { accountId: configured, source: "optional repository override" };
  }

  async function cloudflare(path) {
    const response = await fetchImpl(`${CLOUDFLARE_API_ROOT}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
    const payload = await response.json();
    if (!response.ok || payload.success === false) {
      const errors = Array.isArray(payload.errors)
        ? payload.errors.map((entry) => entry.message || entry.code).join("; ")
        : "unknown Cloudflare API error";
      throw new Error(`${response.status} ${errors}`);
    }
    return Array.isArray(payload.result) ? payload.result : [];
  }

  let zoneDiscoveryError = null;
  try {
    const zones = await cloudflare(
      `/zones?name=${encodeURIComponent(zoneName)}&per_page=50`,
    );
    const zone = zones.find(
      (entry) => entry && entry.name === zoneName && entry.account && entry.account.id,
    );
    if (zone) {
      return { accountId: zone.account.id, source: `${zoneName} zone ownership` };
    }
  } catch (error) {
    zoneDiscoveryError = error;
  }

  const accounts = await cloudflare("/accounts?per_page=50");
  const unique = [
    ...new Map(
      accounts
        .filter((entry) => entry && entry.id)
        .map((entry) => [entry.id, entry]),
    ).values(),
  ];
  const torchMatches = unique.filter((entry) =>
    /\btorch\b/i.test(entry.name || ""),
  );
  const candidate =
    torchMatches.length === 1
      ? torchMatches[0]
      : unique.length === 1
        ? unique[0]
        : null;

  if (!candidate) {
    const zoneNote = zoneDiscoveryError
      ? ` Zone discovery also failed: ${zoneDiscoveryError.message}.`
      : "";
    throw new Error(
      `Unable to resolve a single Torch Cloudflare account from token scope (${unique.length} accounts visible).${zoneNote} Set the optional CLOUDFLARE_ACCOUNT_ID repository Actions secret as a fallback.`,
    );
  }

  return {
    accountId: candidate.id,
    source:
      torchMatches.length === 1
        ? "unique Torch-named account"
        : "single token-visible account",
  };
}

async function main() {
  const { accountId, source } = await resolveCloudflareAccountId({
    token: process.env.CLOUDFLARE_API_TOKEN || "",
    configuredAccountId: process.env.CONFIGURED_CLOUDFLARE_ACCOUNT_ID || "",
  });

  if (!process.env.GITHUB_ENV) {
    throw new Error(
      "GITHUB_ENV is required when running the account resolver as a workflow step.",
    );
  }

  await appendFile(
    process.env.GITHUB_ENV,
    `CLOUDFLARE_ACCOUNT_ID=${accountId}\n`,
    "utf8",
  );
  console.log(`Cloudflare account context resolved via ${source}.`);
}

const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entryUrl === import.meta.url) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
