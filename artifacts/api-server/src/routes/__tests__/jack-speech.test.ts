import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import router from "../jack-speech.js";

let identity = 0;
function app(authenticated = true) {
  const server = express();
  const userId = `speech-test-${++identity}`;
  server.use(express.json());
  server.use((req, _res, next) => {
    if (authenticated) req.userId = userId;
    next();
  });
  server.use("/api", router);
  return server;
}
const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubEnv("ELEVENLABS_API_KEY", "private-test-key");
  vi.stubEnv("JACK_VOICE_ID", "dereks-fixed-clone");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Jack cloned speech", () => {
  it("requires authentication before any provider call", async () => {
    expect(
      (await request(app(false)).post("/api/jack/speech").send({ text: "Hi" }))
        .status,
    ).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([{}, { text: " " }, { text: 12 }, { text: "x".repeat(5001) }])(
    "rejects invalid text %j",
    async (body) => {
      expect(
        (await request(app()).post("/api/jack/speech").send(body)).status,
      ).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it.each(["ELEVENLABS_API_KEY", "JACK_VOICE_ID"])(
    "fails visibly when %s is missing",
    async (key) => {
      vi.stubEnv(key, "");
      const response = await request(app())
        .post("/api/jack/speech")
        .send({ text: "Hi" });
      expect(response.status).toBe(503);
      expect(response.body.code).toBe("JACK_VOICE_UNAVAILABLE");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it("uses only the canonical server voice and returns private audio", async () => {
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array([73, 68, 51]), {
        headers: { "Content-Type": "audio/mpeg" },
      }),
    );
    const response = await request(app())
      .post("/api/jack/speech")
      .send({ text: " Hi ", voiceId: "unrelated-voice" });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("audio/mpeg");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.elevenlabs.io/v1/text-to-speech/dereks-fixed-clone?output_format=mp3_44100_128",
      expect.objectContaining({
        body: JSON.stringify({
          text: "Hi",
          model_id: "eleven_multilingual_v2",
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });
  it.each([401, 429, 500])(
    "degrades on upstream %s without leaking its response",
    async (status) => {
      fetchMock.mockResolvedValue(
        new Response("private provider diagnostics", { status }),
      );
      const response = await request(app())
        .post("/api/jack/speech")
        .send({ text: "Hi" });
      expect(response.status).toBe(503);
      expect(response.body.code).toBe("JACK_VOICE_UNAVAILABLE");
      expect(response.text).not.toContain("private provider");
    },
  );
  it("degrades on connection failure", async () => {
    fetchMock.mockRejectedValue(new Error("secret connection details"));
    expect(
      (await request(app()).post("/api/jack/speech").send({ text: "Hi" }))
        .status,
    ).toBe(503);
  });
  it("aborts a stalled provider at the deadline", async () => {
    const nativeTimeout = globalThis.setTimeout;
    const timerSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((
        callback: (...args: unknown[]) => void,
        ms: number,
        ...args: unknown[]
      ) =>
        nativeTimeout(
          () => callback(...args),
          ms === 30_000 ? 10 : ms,
        )) as typeof setTimeout);
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation(
      (_url, options) =>
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
      expect(
        (await request(app()).post("/api/jack/speech").send({ text: "Hi" }))
          .status,
      ).toBe(503);
      expect(signal?.aborted).toBe(true);
    } finally {
      timerSpy.mockRestore();
    }
  });
  it.each(["text/html", "audio/mpeg"])(
    "rejects invalid or empty provider payload %s",
    async (type) => {
      fetchMock.mockResolvedValue(
        new Response("", { headers: { "Content-Type": type } }),
      );
      expect(
        (await request(app()).post("/api/jack/speech").send({ text: "Hi" }))
          .status,
      ).toBe(503);
    },
  );
  it("bounds provider response bytes", async () => {
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array(8 * 1024 * 1024 + 1), {
        headers: { "Content-Type": "audio/mpeg" },
      }),
    );
    expect(
      (await request(app()).post("/api/jack/speech").send({ text: "Hi" }))
        .status,
    ).toBe(503);
  });
  it("limits requests per authenticated user", async () => {
    vi.stubEnv("JACK_VOICE_ID", "");
    const server = app();
    for (let index = 0; index < 20; index++)
      await request(server).post("/api/jack/speech").send({ text: "Hi" });
    const response = await request(server)
      .post("/api/jack/speech")
      .send({ text: "Hi" });
    expect(response.status).toBe(429);
    expect(response.body.code).toBe("JACK_VOICE_UNAVAILABLE");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
