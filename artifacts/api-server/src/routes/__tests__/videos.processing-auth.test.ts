import { beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

vi.hoisted(() => {
  process.env["ADMIN_EMAILS"] = "admin@torchlabs.ca";
});

const getAuth = vi.hoisted(() => vi.fn());
const getUser = vi.hoisted(() => vi.fn());
vi.mock("@clerk/express", () => ({
  getAuth,
  clerkClient: { users: { getUser } },
}));

vi.mock("../../lib/supabase.js", async () => {
  const mocks = await import("../../lib/__tests__/mocks.js");
  return { supabase: mocks.fake };
});

const claimStage = vi.hoisted(() => vi.fn());
const enqueuePipeline = vi.hoisted(() => vi.fn());
vi.mock("../../lib/jobs.js", () => ({
  claimStage,
  enqueuePipeline,
  syncGraphSafe: vi.fn(),
  removeGraphSafe: vi.fn(),
  CLAIMABLE_STATUSES: ["uploaded", "failed", "retrying"],
  runAnalysis: vi.fn(),
}));

vi.mock("../../lib/rate-limit.js", () => ({
  aiPipelineLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  ingestLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../../lib/video-storage.js", () => ({ removeVideoAssets: vi.fn() }));

import videosRouter from "../videos.js";
import { fake, resetMocks } from "../../lib/__tests__/mocks.js";

const VIDEO_ID = "video-processing-auth";
const UPLOADER_ID = "user-uploader";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const noop = () => {};
    (req as unknown as { log: Record<string, () => void> }).log = {
      warn: noop,
      error: noop,
      info: noop,
      debug: noop,
    };
    next();
  });
  app.use("/api", videosRouter);
  return app;
}

function signInAs(role: "admin" | "uploader" | "other"): void {
  const userId =
    role === "admin"
      ? "user-admin"
      : role === "uploader"
        ? UPLOADER_ID
        : "user-other";
  getAuth.mockReturnValue({ userId });
  getUser.mockResolvedValue({
    firstName: null,
    lastName: null,
    primaryEmailAddress: {
      emailAddress:
        role === "admin" ? "admin@torchlabs.ca" : `${role}@example.com`,
    },
    emailAddresses: [],
    publicMetadata: {},
  });
}

const app = makeApp();

beforeEach(() => {
  resetMocks();
  getAuth.mockReset();
  getUser.mockReset();
  claimStage.mockReset().mockResolvedValue(true);
  enqueuePipeline.mockReset();
  fake.tables["videos"] = [
    {
      id: VIDEO_ID,
      uploader_user_id: UPLOADER_ID,
      status: "uploaded",
      transcript: "captured transcript",
      analysis: null,
    },
  ];
});

describe.each(["transcribe", "analyze"] as const)(
  "POST /videos/:id/%s authorization",
  (operation) => {
    const endpoint = `/api/videos/${VIDEO_ID}/${operation}`;

    it("allows an administrator", async () => {
      signInAs("admin");
      const response = await request(app).post(endpoint);

      expect(response.status).toBe(202);
      expect(claimStage).toHaveBeenCalledOnce();
      expect(enqueuePipeline).toHaveBeenCalledOnce();
    });

    it("allows the video uploader", async () => {
      signInAs("uploader");
      const response = await request(app).post(endpoint);

      expect(response.status).toBe(202);
      expect(claimStage).toHaveBeenCalledOnce();
      expect(enqueuePipeline).toHaveBeenCalledOnce();
    });

    it("rejects a different authenticated user", async () => {
      signInAs("other");
      const response = await request(app).post(endpoint);

      expect(response.status).toBe(403);
      expect(response.body).toEqual({
        error: "Only the uploader can process this video.",
      });
      expect(claimStage).not.toHaveBeenCalled();
      expect(enqueuePipeline).not.toHaveBeenCalled();
    });

    it("rejects an anonymous caller", async () => {
      getAuth.mockReturnValue({ userId: null });
      const response = await request(app).post(endpoint);

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: "Unauthorized" });
      expect(claimStage).not.toHaveBeenCalled();
      expect(enqueuePipeline).not.toHaveBeenCalled();
    });
  },
);
