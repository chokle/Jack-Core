import { describe, expect, it } from "vitest";
import type { IncomingHttpHeaders } from "node:http";
import {
  CLERK_PROXY_PATH,
  clerkFrontendApiProxyOptions,
  sanitizeClerkProxyHeaders,
} from "../clerkProxyMiddleware";

describe("Clerk proxy edge headers", () => {
  it("preserves client IP without replaying inbound Cloudflare identity", () => {
    const headers: IncomingHttpHeaders = {
      "cf-connecting-ip": "203.0.113.7",
      "cf-connecting-ipv6": "2001:db8::1",
      "x-forwarded-for": "203.0.113.7, 10.0.0.1",
      cookie: "session=test",
    };
    sanitizeClerkProxyHeaders("/api/__clerk/v1/environment", headers);
    expect(headers).toEqual({
      "x-forwarded-for": "203.0.113.7",
      cookie: "session=test",
    });
  });
  it("leaves other routes and their security headers untouched", () => {
    const headers = { "cf-connecting-ip": "203.0.113.7" };
    sanitizeClerkProxyHeaders("/api/__clerk-other", headers);
    expect(headers).toEqual({ "cf-connecting-ip": "203.0.113.7" });
  });
  it("preserves existing XFF when there is no Cloudflare identity", () => {
    const headers = { "x-forwarded-for": "203.0.113.7" };
    sanitizeClerkProxyHeaders("/api/__clerk", headers);
    expect(headers).toEqual({ "x-forwarded-for": "203.0.113.7" });
  });
});

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
