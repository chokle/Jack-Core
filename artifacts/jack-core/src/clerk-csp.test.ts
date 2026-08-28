import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const policy = html.match(
  /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/,
)?.[1];

describe("Clerk Content Security Policy", () => {
  it("allows the exact production and staging Clerk Frontend APIs without a broad Torch wildcard", () => {
    expect(policy).toBeDefined();

    const directives = policy
      ?.split(";")
      .map((directive) => directive.trim());
    const scriptSrc = directives?.find((directive) => directive.startsWith("script-src "));
    const connectSrc = directives?.find((directive) => directive.startsWith("connect-src "));
    const frameSrc = directives?.find((directive) => directive.startsWith("frame-src "));

    expect(scriptSrc).toContain("https://clerk.jack.torchlabs.ca");
    expect(scriptSrc).toContain("https://clerk.staging.jack.torchlabs.ca");
    expect(connectSrc).toContain("https://clerk.torchlabs.ca");
    expect(connectSrc).toContain("https://clerk.jack.torchlabs.ca");
    expect(connectSrc).toContain("https://clerk.staging.jack.torchlabs.ca");
    expect(frameSrc).toContain("https://clerk.staging.jack.torchlabs.ca");
    expect(connectSrc).not.toContain("https://*.torchlabs.ca");
    expect(connectSrc).not.toContain("* ");
  });
});
