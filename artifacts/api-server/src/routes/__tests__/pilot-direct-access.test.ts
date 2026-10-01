import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
const mint = vi.hoisted(() => vi.fn());
vi.mock("@clerk/express", () => ({
  clerkClient: { signInTokens: { createSignInToken: mint } },
}));
import router from "../pilot-direct-access.js";
describe("retired direct access", () => {
  it.each(["", "nick@torchlabs.ca", "anything@example.com"])(
    "never issues a token from email %s",
    async (email) => {
      const app = express();
      app.use(express.json(), router);
      const response = await request(app).post("/").send({ email });
      expect(response.status).toBe(410);
      expect(response.body.signInUrl).toBe("/sign-in");
      expect(response.headers["cache-control"]).toContain("no-store");
      expect(mint).not.toHaveBeenCalled();
    },
  );
});
