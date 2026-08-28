const ORIGIN_OVERRIDE = "staging-origin.jack.torchlabs.ca";

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://clerk.jack.torchlabs.ca https://clerk.staging.jack.torchlabs.ca https://*.clerk.accounts.dev https://*.clerk.com https://frontend-api.clerk.dev https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  "connect-src 'self' https://jack.torchlabs.ca https://staging.jack.torchlabs.ca https://*.supabase.co https://clerk.torchlabs.ca https://clerk.jack.torchlabs.ca https://clerk.staging.jack.torchlabs.ca https://*.clerk.accounts.dev https://*.clerk.com https://frontend-api.clerk.dev https://clerk-telemetry.com",
  "worker-src 'self' blob:",
  "frame-src 'self' https://challenges.cloudflare.com https://clerk.staging.jack.torchlabs.ca https://*.clerk.accounts.dev https://*.clerk.com",
  "object-src 'none'",
  "base-uri 'self'",
].join("; ");

class CspMetaElementHandler {
  element(element) {
    const httpEquiv = element.getAttribute("http-equiv");
    if (httpEquiv?.toLowerCase() === "content-security-policy") {
      element.setAttribute("content", CONTENT_SECURITY_POLICY);
    }
  }
}

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set("content-security-policy", CONTENT_SECURITY_POLICY);
  headers.set("x-jack-staging-csp-hotfix", "2026-08-28");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.hostname !== "staging.jack.torchlabs.ca") {
      return new Response("Not found", { status: 404 });
    }

    const originRequest = new Request(request, {
      redirect: "manual",
      cf: {
        resolveOverride: ORIGIN_OVERRIDE,
        cacheTtl: 0,
      },
    });
    const originResponse = await fetch(originRequest);
    const securedResponse = withSecurityHeaders(originResponse);
    const contentType = securedResponse.headers.get("content-type") || "";

    if (!contentType.toLowerCase().includes("text/html")) {
      return securedResponse;
    }

    return new HTMLRewriter()
      .on("meta[http-equiv]", new CspMetaElementHandler())
      .transform(securedResponse);
  },
};
