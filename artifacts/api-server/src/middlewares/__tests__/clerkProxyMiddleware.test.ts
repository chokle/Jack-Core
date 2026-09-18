import { describe, expect, it } from "vitest";
import {
  CLERK_PROXY_PATH,
  clerkFrontendApiProxyOptions,
} from "../clerkProxyMiddleware";

describe("clerkFrontendApiProxyOptions", () => {
  it("enables Clerk's supported same-origin proxy in production", () => {
    expect(clerkFrontendApiProxyOptions("production")).toEqual({
      enabled: true,
      path: "/api/__clerk",
    });
  });

  it("keeps proxy transport disabled outside production", () => {
    expect(clerkFrontendApiProxyOptions("development")).toEqual({
      enabled: false,
      path: "/api/__clerk",
    });
    expect(clerkFrontendApiProxyOptions("test")).toEqual({
      enabled: false,
      path: "/api/__clerk",
    });
  });

  it("keeps the browser and server proxy path contract stable", () => {
    expect(CLERK_PROXY_PATH).toBe("/api/__clerk");
  });
});
