import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const policy = html.match(
  /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/,
)?.[1];

describe("Clerk Content Security Policy", () => {
  it("allows the production Clerk Frontend API without broadening connect-src", () => {
    expect(policy).toBeDefined();

    const connectSrc = policy
      ?.split(";")
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith("connect-src "));

    expect(connectSrc).toContain("https://clerk.torchlabs.ca");
    expect(connectSrc).not.toContain("https://*.torchlabs.ca");
    expect(connectSrc).not.toContain("* ");
  });
});
