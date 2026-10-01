import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transcribe: vi.fn(),
  membership: vi.fn(),
  identity: vi.fn(),
  from: vi.fn(),
  videos: vi.fn(),
}));
vi.mock("../../lib/transcription.js", () => ({
  transcribeAudioBuffer: mocks.transcribe,
}));
vi.mock("../../lib/activity-telemetry.js", () => ({
  resolveActiveTesterScope: mocks.membership,
}));
vi.mock("../../lib/admin-auth.js", () => ({ resolveIdentity: mocks.identity }));
vi.mock("../../lib/supabase.js", () => ({ supabase: { from: mocks.from } }));
vi.mock("../../lib/library-read-policy.js", () => ({
  readableVideos: mocks.videos,
}));

import router from "../jack-field-client.js";

const ID = "11111111-1111-4111-8111-111111111111";
const scope = { organizationId: "org-a", pilotId: "pilot-a" };
let sequence = 0;
function app(authenticated = true) {
  const server = express();
  const userId = `native-user-${++sequence}`;
  server.use((req, _res, next) => {
    if (authenticated) req.userId = userId;
    req.log = { warn: vi.fn(), error: vi.fn() } as unknown as typeof req.log;
    next();
  });
  server.use("/api", router);
  return server;
}
function query(data: unknown, error: unknown = null) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data, error }),
  };
  return chain;
}
function audio(
  server = app(),
  contentType = "audio/mp4",
  bytes = Buffer.from("private clip"),
) {
  return request(server)
    .post("/api/jack/transcribe")
    .attach("audio", bytes, { filename: "private-name.m4a", contentType });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("PILOT_AUTH_BYPASS", "false");
  mocks.membership.mockResolvedValue({ scope });
  mocks.identity.mockResolvedValue({
    isAdmin: false,
    classification: "resolved",
  });
  mocks.transcribe.mockResolvedValue("Turn off the supply first.");
  mocks.from.mockReturnValue(query(null));
  mocks.videos.mockReturnValue(query(null));
});
afterEach(() => vi.unstubAllEnvs());

describe("native transient transcription", () => {
  it.each([
    "/api/jack/transcribe/",
    "/api/JACK/TRANSCRIBE",
    `/api/JACK/SOURCES/video/${ID}/`,
  ])("retains membership gating for Express path variant %s", async (path) => {
    mocks.membership.mockResolvedValue({ scope: null, reason: "not_enrolled" });
    const server = request(app());
    const res = path.toLowerCase().includes("/sources/")
      ? await server.get(path)
      : await server.post(path).send({});
    expect(res.status).toBe(403);
    expect(mocks.transcribe).not.toHaveBeenCalled();
    expect(mocks.videos).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it("requires authentication before parsing invalid multipart or calling a provider", async () => {
    const res = await request(app(false))
      .post("/api/jack/transcribe")
      .set("Content-Type", "multipart/form-data; boundary=broken")
      .send("invalid");
    expect(res.status).toBe(401);
    expect(mocks.membership).not.toHaveBeenCalled();
    expect(mocks.transcribe).not.toHaveBeenCalled();
  });
  it("requires pilot authorization before multipart parsing and paid work", async () => {
    mocks.membership.mockResolvedValue({ scope: null, reason: "not_enrolled" });
    const res = await request(app())
      .post("/api/jack/transcribe")
      .set("Content-Type", "multipart/form-data; boundary=broken")
      .send("invalid");
    expect(res.status).toBe(403);
    expect(mocks.transcribe).not.toHaveBeenCalled();
  });
  it("transcribes Android m4a with bounded timeout, cancellation and zero retries", async () => {
    const bytes = Buffer.from("private clip");
    let providerBuffer: Buffer | undefined;
    mocks.transcribe.mockImplementation(async (buffer) => {
      providerBuffer = buffer;
      return "Turn off the supply first.";
    });
    const res = await audio(app(), "audio/mp4", bytes);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ text: "Turn off the supply first." });
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(mocks.transcribe).toHaveBeenCalledWith(
      expect.any(Buffer),
      "question.m4a",
      {
        signal: expect.any(AbortSignal),
        timeout: 30_000,
        maxRetries: 0,
      },
    );
    expect(providerBuffer?.every((value) => value === 0)).toBe(true);
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it.each(["application/octet-stream", "text/plain", "image/png", "video/mp4"])(
    "rejects MIME %s before provider work",
    async (mime) => {
      expect((await audio(app(), mime)).status).toBe(400);
      expect(mocks.transcribe).not.toHaveBeenCalled();
    },
  );
  it("rejects oversized audio before provider work", async () => {
    expect(
      (await audio(app(), "audio/mp4", Buffer.alloc(8 * 1024 * 1024 + 1)))
        .status,
    ).toBe(413);
    expect(mocks.transcribe).not.toHaveBeenCalled();
  });
  it("rejects missing or empty recordings", async () => {
    expect(
      (await request(app()).post("/api/jack/transcribe").send({})).status,
    ).toBe(400);
    expect((await audio(app(), "audio/mp4", Buffer.alloc(0))).status).toBe(400);
    expect(mocks.transcribe).not.toHaveBeenCalled();
  });
  it("does not expose provider diagnostics", async () => {
    mocks.transcribe.mockRejectedValue(
      new Error("private provider credential/audio diagnostics"),
    );
    const res = await audio();
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("JACK_TRANSCRIPTION_UNAVAILABLE");
    expect(res.text).not.toContain("private provider");
  });
  it("reports no detected speech as 422", async () => {
    mocks.transcribe.mockResolvedValue(" ");
    expect((await audio()).status).toBe(422);
  });
  it("aborts provider work at the deadline", async () => {
    const nativeTimeout = globalThis.setTimeout;
    const timer = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((callback, ms, ...args) =>
        nativeTimeout(
          callback,
          ms === 30_000 ? 10 : ms,
          ...args,
        )) as typeof setTimeout);
    let signal: AbortSignal | undefined;
    mocks.transcribe.mockImplementation(
      (_buffer, _filename, options) =>
        new Promise((_resolve, reject) => {
          signal = options.signal;
          signal!.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        }),
    );
    try {
      expect((await audio()).status).toBe(503);
      expect(signal?.aborted).toBe(true);
    } finally {
      timer.mockRestore();
    }
  });
  it("cancels paid work when the caller disconnects", async () => {
    let notifyStarted!: () => void;
    let notifyAborted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      notifyAborted = resolve;
    });
    mocks.transcribe.mockImplementation(
      (_buffer, _filename, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => {
              notifyAborted();
              reject(new Error("aborted"));
            },
            { once: true },
          );
          notifyStarted();
        }),
    );
    const pending = audio();
    const result = pending.then(
      () => undefined,
      () => undefined,
    );
    await started;
    pending.abort();
    await aborted;
    await result;
  });
  it("closes the response at the deadline even if an adapter ignores abort", async () => {
    const nativeTimeout = globalThis.setTimeout;
    const timer = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((callback, ms, ...args) =>
        nativeTimeout(
          callback,
          ms === 30_000 ? 10 : ms,
          ...args,
        )) as typeof setTimeout);
    mocks.transcribe.mockImplementation(() => new Promise(() => {}));
    try {
      expect((await audio()).status).toBe(503);
    } finally {
      timer.mockRestore();
    }
  });
  it("limits per server-derived user and ignores spoofed client identity", async () => {
    const server = app();
    for (let index = 0; index < 10; index++) await audio(server);
    const res = await audio(server).set("X-User-Id", "different-user");
    expect(res.status).toBe(429);
    expect(mocks.transcribe).toHaveBeenCalledTimes(10);
    expect((await audio(app())).status).toBe(200);
  });
});

describe("native canonical source reads", () => {
  it("requires authentication before any source read", async () => {
    expect(
      (await request(app(false)).get(`/api/jack/sources/video/${ID}`)).status,
    ).toBe(401);
    expect(mocks.videos).not.toHaveBeenCalled();
  });
  it("requires pilot access before any source read", async () => {
    mocks.membership.mockResolvedValue({ scope: null });
    expect(
      (await request(app()).get(`/api/jack/sources/video/${ID}`)).status,
    ).toBe(403);
    expect(mocks.videos).not.toHaveBeenCalled();
  });
  it("uses canonical video readability and returns only private playback route", async () => {
    mocks.videos.mockReturnValue(
      query({
        id: ID,
        title: "Valve",
        transcript: "Close valve",
        video_url: "https://private-storage.invalid/secret?token=hidden",
        metadata: { secret: true },
      }),
    );
    const res = await request(app()).get(`/api/jack/sources/video/${ID}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      title: "Valve",
      text: "Close valve",
      videoUrl: `/api/videos/${ID}/play`,
    });
    expect(mocks.videos).toHaveBeenCalledWith(
      expect.stringMatching(/^native-user-/),
    );
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.text).not.toContain("private-storage");
  });
  it("opens matching tenant knowledge without leaking metadata", async () => {
    mocks.from.mockReturnValue(
      query({
        title: "Safety",
        description: "Check",
        body: "Inspect",
        metadata: { ...scope, contributor: "private name" },
      }),
    );
    const res = await request(app()).get(`/api/jack/sources/knowledge/${ID}`);
    expect(res.body).toEqual({ title: "Safety", text: "Check\n\nInspect" });
  });
  it.each([
    { organizationId: "org-b", pilotId: "pilot-a" },
    { organizationId: "org-a", pilotId: "pilot-b" },
    { pilotId: "pilot-a" },
    { organizationId: "org-a" },
  ])("denies mismatched or incomplete scope %j", async (metadata) => {
    mocks.from.mockReturnValue(
      query({ title: "Hidden", body: "private", metadata }),
    );
    const res = await request(app()).get(`/api/jack/sources/knowledge/${ID}`);
    expect(res.status).toBe(404);
    expect(res.text).not.toContain("private");
  });
  it("allows canonical unscoped knowledge for pilot-authorized admins without a tester scope", async () => {
    mocks.membership.mockResolvedValue({ scope: null });
    mocks.identity.mockResolvedValue({
      isAdmin: true,
      classification: "resolved",
    });
    mocks.from.mockReturnValue(
      query({ title: "Shared", body: "canonical", metadata: {} }),
    );
    expect(
      (await request(app()).get(`/api/jack/sources/knowledge/${ID}`)).status,
    ).toBe(200);
  });
  it("denies scoped knowledge with unresolved or ambiguous membership even for an admin", async () => {
    mocks.membership.mockResolvedValue({
      scope: null,
      reason: "ambiguous_pilot",
    });
    mocks.identity.mockResolvedValue({
      isAdmin: true,
      classification: "resolved",
    });
    mocks.from.mockReturnValue(
      query({ title: "Hidden", body: "private", metadata: scope }),
    );
    expect(
      (await request(app()).get(`/api/jack/sources/knowledge/${ID}`)).status,
    ).toBe(404);
    expect(mocks.from).toHaveBeenCalledWith("knowledge_entries");
    expect(mocks.from).not.toHaveBeenCalledWith("knowledge_nodes");
  });
  it("never falls through missing knowledge entry to global memory-node lookup", async () => {
    expect(
      (await request(app()).get(`/api/jack/sources/knowledge/${ID}`)).status,
    ).toBe(404);
    expect(mocks.from).toHaveBeenCalledTimes(1);
    expect(mocks.from).toHaveBeenCalledWith("knowledge_entries");
  });
  it("fails closed for non-UUID graph-memory citation IDs", async () => {
    expect(
      (
        await request(app()).get(
          "/api/jack/sources/knowledge/memory-valve-node",
        )
      ).status,
    ).toBe(400);
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it("does not expose database diagnostics", async () => {
    mocks.from.mockReturnValue(
      query(null, new Error("private database details")),
    );
    const res = await request(app()).get(`/api/jack/sources/knowledge/${ID}`);
    expect(res.status).toBe(503);
    expect(res.text).not.toContain("database");
  });
  it.each(["authority", "node", "video/not-a-uuid"])(
    "rejects invalid source %s",
    async (value) => {
      const path = value.includes("/") ? value : `${value}/${ID}`;
      expect(
        (await request(app()).get(`/api/jack/sources/${path}`)).status,
      ).toBe(400);
      expect(mocks.videos).not.toHaveBeenCalled();
      expect(mocks.from).not.toHaveBeenCalled();
    },
  );
});
