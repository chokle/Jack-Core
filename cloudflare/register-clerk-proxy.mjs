import { pathToFileURL } from "node:url";

export async function registerClerkProxy(secret, fetcher = fetch) {
  const expected = "https://jack.torchlabs.ca/api/__clerk";
  if (!secret?.startsWith("sk_live_"))
    throw new Error("Live Clerk credential required");
  async function api(path, init = {}) {
    const response = await fetcher(`https://api.clerk.com/v1/${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok)
      throw new Error(
        `Clerk API returned HTTP ${response.status}; reconcile before retry`,
      );
    return response.json();
  }
  const payload = await api("domains?limit=100");
  const domains = Array.isArray(payload) ? payload : payload.data;
  const matches = domains.filter(
    (d) => d.name === "torchlabs.ca" && !d.is_satellite,
  );
  if (matches.length !== 1)
    throw new Error("Expected exactly one Torch primary domain");
  const domain = matches[0];
  console.log(
    JSON.stringify({
      domain: domain.name,
      previous_proxy_url: domain.proxy_url ?? null,
    }),
  );
  if (domain.proxy_url && domain.proxy_url !== expected)
    throw new Error("Unexpected existing proxy URL; no mutation performed");
  const ready = await fetcher(`${expected}/v1/environment`, {
    signal: AbortSignal.timeout(10000),
  });
  const body = ready.headers.get("content-type")?.includes("application/json")
    ? await ready.json()
    : null;
  // A reachable but unregistered Clerk proxy reports host_invalid. Requiring
  // 200 before registration creates a circular gate; accept only this precise
  // Clerk response, never the Cloudflare403 or an arbitrary error page.
  const awaitingRegistration =
    ready.status === 400 &&
    typeof body?.clerk_trace_id === "string" &&
    body?.errors?.length === 1 &&
    body.errors[0].code === "host_invalid";
  if ((!ready.ok || !body) && !awaitingRegistration)
    throw new Error("Canonical proxy is not ready; no mutation performed");
  if (domain.proxy_url !== expected)
    await api(`domains/${encodeURIComponent(domain.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ proxy_url: expected }),
    });
  const after = await api("domains?limit=100");
  const rows = Array.isArray(after) ? after : after.data;
  if (!rows.some((d) => d.id === domain.id && d.proxy_url === expected))
    throw new Error(
      "Proxy registration readback failed; reconcile before retry",
    );
  console.log("Canonical Clerk proxy registration verified");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await registerClerkProxy(process.env.CLERK_SECRET_KEY);
}
