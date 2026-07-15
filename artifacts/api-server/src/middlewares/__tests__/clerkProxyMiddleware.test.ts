import { describe, expect, it } from "vitest";
import { buildPublishableKey } from "@clerk/shared/keys";
import { getClerkProxyTarget } from "../clerkProxyMiddleware";

describe("getClerkProxyTarget", () => {
  it("routes development instances to their own frontend API", () => {
    const key = buildPublishableKey("free-roughy-91.clerk.accounts.dev");

    expect(getClerkProxyTarget(key)).toBe(
      "https://free-roughy-91.clerk.accounts.dev",
    );
  });

  it("uses an explicitly configured Clerk target", () => {
    expect(
      getClerkProxyTarget(
        undefined,
        "https://free-roughy-91.clerk.accounts.dev/",
      ),
    ).toBe("https://free-roughy-91.clerk.accounts.dev");
  });

  it("rejects configured targets outside Clerk", () => {
    expect(
      getClerkProxyTarget(
        " ",
        "https://example.com/not-a-clerk-instance",
      ),
    ).toBe("https://frontend-api.clerk.dev");
  });

  it("keeps production proxy traffic on Clerk's proxy frontend API", () => {
    const encodedHost = Buffer.from("clerk.example.com$")
      .toString("base64")
      .replace(/=+$/, "");

    expect(getClerkProxyTarget(`pk_live_${encodedHost}`, " ")).toBe(
      "https://frontend-api.clerk.dev",
    );
  });

  it("uses Clerk's proxy frontend API when no key is configured", () => {
    expect(getClerkProxyTarget(" ", " ")).toBe(
      "https://frontend-api.clerk.dev",
    );
  });
});
