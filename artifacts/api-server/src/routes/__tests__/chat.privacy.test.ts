/**
 * Chat history is scoped to the SIGNED-IN ACCOUNT (server-derived Clerk user id),
 * not to the anonymous per-device session cookie. This guards the privacy
 * guarantees behind Task "Keep each person's chat history tied to their account
 * across devices":
 *   - a user sees their own history on any device (history keyed by user id, not
 *     a device cookie),
 *   - another user on the SAME device (same session cookie) never sees it, and
 *   - legacy pre-auth rows (user_id = NULL) are never returned as global rows.
 *
 * The user id is injected by the test middleware to stand in for the app-level
 * requireAuth gate (which the bare router mount here does not run); a request
 * header selects which user the middleware asserts, letting one app simulate
 * two accounts hitting the same endpoint.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";
import express, { type Express, type Request } from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

vi.mock("../../lib/supabase.js", async () => {
  const m = await import("../../lib/__tests__/mocks.js");
  return { supabase: m.fake };
});

vi.mock("../../lib/openai.js", async () => {
  const m = await import("../../lib/__tests__/mocks.js");
  return {
    createEmbedding: m.createEmbedding,
    chatCompletion: vi.fn(async () => ({
      choices: [{ message: { content: "An answer." } }],
    })),
    MODELS: m.MODELS,
    openai: m.openai,
  };
});

import chatRouter from "../chat.js";
import { fake, resetMocks } from "../../lib/__tests__/mocks.js";

const USER_A = "user_aaaaaaaaaaaaaaaaaaaaaa";
const USER_B = "user_bbbbbbbbbbbbbbbbbbbbbb";
// A device-scoped session cookie shared by whoever uses this browser.
const SHARED_SESSION = "11111111-1111-1111-1111-111111111111";

// The middleware reads `x-test-user` and sets req.userId from it, mimicking the
// requireAuth gate resolving the Clerk user. An absent header means "no user".
function makeApp(): Express {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use((req: Request, _res, next) => {
    const noop = () => {};
    (req as unknown as { log: Record<string, () => void> }).log = {
      warn: noop,
      error: noop,
      info: noop,
      debug: noop,
    };
    const header = req.headers["x-test-user"];
    if (typeof header === "string" && header.length > 0) {
      (req as unknown as { userId: string }).userId = header;
    }
    next();
  });
  app.use("/api", chatRouter);
  return app;
}

const app = makeApp();

interface HistoryRow {
  role: string;
  content: string;
}

beforeEach(() => {
  resetMocks();
});

describe("GET /api/chat/history — account-scoped, not device-scoped", () => {
  it("returns only the signed-in user's messages, isolating two accounts on the same device", async () => {
    // Both users share the SAME session cookie (same device), but each owns
    // distinct messages by user_id.
    fake.tables["chat_messages"] = [
      { id: "a1", session_id: SHARED_SESSION, user_id: USER_A, role: "user", content: "A question", citations: [], created_at: "2026-01-01T00:00:00Z" },
      { id: "a2", session_id: SHARED_SESSION, user_id: USER_A, role: "assistant", content: "A answer", citations: [], created_at: "2026-01-01T00:00:01Z" },
      { id: "b1", session_id: SHARED_SESSION, user_id: USER_B, role: "user", content: "B secret", citations: [], created_at: "2026-01-01T00:00:02Z" },
    ];

    const resA = await request(app)
      .get("/api/chat/history")
      .set("x-test-user", USER_A)
      .set("Cookie", `jack_session=${SHARED_SESSION}`);
    expect(resA.status).toBe(200);
    const aRows = resA.body as HistoryRow[];
    expect(aRows.map((r) => r.content)).toEqual(["A question", "A answer"]);
    // User A must never see User B's message even on the shared device.
    expect(aRows.some((r) => r.content === "B secret")).toBe(false);

    const resB = await request(app)
      .get("/api/chat/history")
      .set("x-test-user", USER_B)
      .set("Cookie", `jack_session=${SHARED_SESSION}`);
    expect(resB.status).toBe(200);
    expect((resB.body as HistoryRow[]).map((r) => r.content)).toEqual(["B secret"]);
  });

  it("never returns legacy pre-auth rows (user_id NULL) as global rows", async () => {
    fake.tables["chat_messages"] = [
      { id: "legacy", session_id: SHARED_SESSION, user_id: null, role: "user", content: "orphaned legacy", citations: [], created_at: "2025-01-01T00:00:00Z" },
    ];

    const res = await request(app)
      .get("/api/chat/history")
      .set("x-test-user", USER_A)
      .set("Cookie", `jack_session=${SHARED_SESSION}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns nothing when there is no resolvable user (fail-closed)", async () => {
    fake.tables["chat_messages"] = [
      { id: "a1", session_id: SHARED_SESSION, user_id: USER_A, role: "user", content: "A question", citations: [], created_at: "2026-01-01T00:00:00Z" },
    ];
    const res = await request(app).get("/api/chat/history");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe("POST /api/chat — writes carry the owner and load account history", () => {
  it("stamps the user id on new rows and only threads the same user's prior turns", async () => {
    // A prior message from a DIFFERENT user on the same device must not leak into
    // this user's conversation context — and the new rows must be owned by USER_A.
    fake.tables["chat_messages"] = [
      { id: "b1", session_id: SHARED_SESSION, user_id: USER_B, role: "user", content: "B earlier turn", citations: [], created_at: "2026-01-01T00:00:00Z" },
    ];

    const res = await request(app)
      .post("/api/chat")
      .set("x-test-user", USER_A)
      .set("Cookie", `jack_session=${SHARED_SESSION}`)
      .send({ message: "A new question" });
    expect(res.status).toBe(200);

    const rows = fake.tables["chat_messages"];
    const aRows = rows.filter((r) => r["user_id"] === USER_A);
    expect(aRows).toHaveLength(2);
    expect(aRows.map((r) => r["role"])).toEqual(["user", "assistant"]);
    // The other user's row is untouched and still owned by B.
    expect(rows.filter((r) => r["user_id"] === USER_B)).toHaveLength(1);
  });

  it("rejects an unauthenticated write (fail-closed) rather than writing an unowned row", async () => {
    const res = await request(app).post("/api/chat").send({ message: "hi" });
    expect(res.status).toBe(401);
    expect(fake.tables["chat_messages"]).toHaveLength(0);
  });
});
