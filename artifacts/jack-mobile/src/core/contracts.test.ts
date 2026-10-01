import { test } from "node:test";
import assert from "node:assert/strict";
import {
  JackApi,
  JackApiError,
  authorizedMediaUrl,
  officialSourceUrl,
  validateApiOrigin,
} from "./api";
import { encodeContext } from "./context";
import { RequestScope } from "./request-scope";
import { createSecureTokenCache } from "./secure-token-cache";
import { CapabilityBus } from "./capabilities";
import { SerialTransitions, isOwnedRecordingName } from "./transitions";

test("navigation/sign-out/organization/background invalidation cancels every request and rejects late completions", () => {
  const scope = new RequestScope();
  const alertIntent = scope.capture();
  const chat = scope.begin();
  const audio = scope.begin();
  scope.invalidate();
  assert.equal(chat.signal.aborted, true);
  assert.equal(audio.signal.aborted, true);
  assert.equal(chat.current(), false);
  assert.equal(chat.owns(), false);
  assert.equal(alertIntent(), false);
  const fresh = scope.begin();
  assert.equal(fresh.current(), true);
  chat.finish();
  audio.finish();
  fresh.finish();
});

test("timeout cannot publish but retains ownership so UI can recover from timeout", async () => {
  const task = new RequestScope().begin(2);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(task.current(), false);
  assert.equal(task.owns(), true);
  assert.equal(task.signal.aborted, true);
  task.finish();
});

test("no request can leave after token retrieval if its context was cancelled", async () => {
  let resolveToken!: (value: string) => void;
  const token = new Promise<string>((resolve) => {
    resolveToken = resolve;
  });
  let calls = 0;
  const api = new JackApi(
    "https://jack.torchlabs.ca",
    () => token,
    async () => {
      calls += 1;
      return new Response();
    },
  );
  const controller = new AbortController();
  const pending = api.ask(
    "question",
    encodeContext("ask", null),
    controller.signal,
  );
  controller.abort();
  resolveToken("secret-token");
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(calls, 0);
});

test("real API calls carry fresh bearer and canonical context; provider errors never leak payload text", async () => {
  let observed: RequestInit | undefined;
  const api = new JackApi(
    "https://jack.torchlabs.ca",
    async () => "session-token",
    async (url, options) => {
      assert.equal(url, "https://jack.torchlabs.ca/api/chat");
      observed = options;
      return Response.json(
        { error: "private provider text", code: "PILOT_ACCESS_REQUIRED" },
        { status: 403 },
      );
    },
  );
  const context = encodeContext("ask", null);
  await assert.rejects(
    api.ask("field question", context, new AbortController().signal),
    (error: unknown) =>
      error instanceof JackApiError &&
      error.status === 403 &&
      !error.message.includes("private"),
  );
  const headers = new Headers(observed?.headers);
  assert.equal(headers.get("Authorization"), "Bearer session-token");
  assert.equal(headers.get("X-Jack-Context"), context);
  assert.equal(observed?.redirect, "error");
  assert.equal(observed?.cache, "no-store");
});

test("missing authentication fails closed without making a request", async () => {
  let calls = 0;
  const api = new JackApi(
    "https://jack.torchlabs.ca",
    async () => null,
    async () => {
      calls += 1;
      return new Response();
    },
  );
  await assert.rejects(
    api.ask(
      "question",
      encodeContext("ask", null),
      new AbortController().signal,
    ),
    (error: unknown) => error instanceof JackApiError && error.status === 401,
  );
  assert.equal(calls, 0);
});

test("media bearer can only target exact protected route; public sources reject credentials and schemes", () => {
  assert.equal(
    authorizedMediaUrl(
      "https://jack.torchlabs.ca",
      "/api/videos/video-1/play",
      "video-1",
    ),
    "https://jack.torchlabs.ca/api/videos/video-1/play",
  );
  for (const url of [
    "https://evil.test/play",
    "//evil.test/play",
    "/api/videos/video-1/play?redirect=evil",
    "/api/videos/other/play",
  ])
    assert.throws(() =>
      authorizedMediaUrl("https://jack.torchlabs.ca", url, "video-1"),
    );
  for (const url of [
    "javascript:alert(1)",
    "http://site.test",
    "https://token@site.test",
  ])
    assert.throws(() => officialSourceUrl(url));
  for (const url of [
    "http://jack.torchlabs.ca",
    "https://token@jack.torchlabs.ca",
    "https://jack.torchlabs.ca/api",
  ])
    assert.throws(() => validateApiOrigin(url));
});

test("context describes actual native source, stays within encoded bounds and contains no question or device data", () => {
  const encoded = encodeContext(
    "source",
    { id: "memory:node", title: "🔨".repeat(120) },
    new Date("2026-09-30T12:00:00Z"),
  );
  assert.ok(encoded.length <= 3500);
  const context = JSON.parse(decodeURIComponent(encoded));
  assert.deepEqual(context.visibleIds, ["memory:node"]);
  assert.equal(context.inspector.open, true);
  assert.equal(context.navigation.canBack, true);
  assert.equal(context.capturedAt, "2026-09-30T12:00:00.000Z");
  assert.equal(context.location, undefined);
  assert.equal(context.question, undefined);
});

test("secure session cache never falls back to plaintext and clears the actual platform key", async () => {
  const entries = new Map<string, string>();
  const cache = createSecureTokenCache({
    getItemAsync: async (key) => entries.get(key) ?? null,
    setItemAsync: async (key, value) => {
      entries.set(key, value);
    },
    deleteItemAsync: async (key) => {
      entries.delete(key);
    },
  });
  await cache.saveToken("clerk-session", "private");
  assert.equal(await cache.getToken("clerk-session"), "private");
  await cache.clearToken("clerk-session");
  assert.equal(await cache.getToken("clerk-session"), null);
  const failed = createSecureTokenCache({
    getItemAsync: async () => {
      throw new Error("keystore unavailable");
    },
    setItemAsync: async () => {
      throw new Error("keystore unavailable");
    },
    deleteItemAsync: async () => {},
  });
  await assert.rejects(failed.saveToken("clerk-session", "private"));
  await assert.rejects(failed.getToken("clerk-session"));
});

test("detached hardware stops before becoming unavailable and never invents a GPS/camera capability", async () => {
  const bus = new CapabilityBus();
  let stopped = 0;
  bus.attach({
    id: "microphone",
    permission: async () => "denied",
    stop: async () => {
      stopped += 1;
    },
  });
  assert.equal(await bus.get("microphone")?.permission(), "denied");
  await bus.detach("microphone");
  assert.equal(stopped, 1);
  assert.equal(bus.get("microphone"), undefined);
});

test("microphone stop and new prepare serialize behind the previous prepare, even when it was cancelled", async () => {
  const transitions = new SerialTransitions();
  const calls: string[] = [];
  let prepared!: () => void;
  const first = transitions.run(async () => {
    calls.push("prepare-old");
    await new Promise<void>((resolve) => {
      prepared = resolve;
    });
    calls.push("prepared-old");
  });
  const stop = transitions.run(async () => {
    calls.push("stop-old");
  });
  const second = transitions.run(async () => {
    calls.push("prepare-new");
  });
  await Promise.resolve();
  assert.deepEqual(calls, ["prepare-old"]);
  prepared();
  await Promise.all([first, stop, second]);
  assert.deepEqual(calls, [
    "prepare-old",
    "prepared-old",
    "stop-old",
    "prepare-new",
  ]);
});

test("crash cleanup selects only native recording UUID files, never unrelated cache files", () => {
  assert.equal(
    isOwnedRecordingName("recording-12345678-1234-1234-1234-123456789abc.m4a"),
    true,
  );
  for (const name of [
    "unrelated.m4a",
    "recording-not-a-uuid.m4a",
    "../recording-12345678-1234-1234-1234-123456789abc.m4a",
    "source.mp4",
  ])
    assert.equal(isOwnedRecordingName(name), false);
});
