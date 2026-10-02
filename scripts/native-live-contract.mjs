// Availability and anonymous auth boundaries only. This is not signed-in acceptance.
import assert from "node:assert/strict";

const origin = "https://jack.torchlabs.ca";
const cases = [
  ["GET", "/api/healthz", 200],
  ["GET", "/api/me", 401],
  ["GET", "/api/chat/history", 401],
  ["POST", "/api/chat", 401],
  ["POST", "/api/jack/speech", 401],
  ["POST", "/api/jack/transcribe", 401],
  ["GET", "/api/jack/sources/knowledge/anonymous-boundary-probe", 401],
];
for (const [method, path, expected] of cases) {
  const response = await fetch(`${origin}${path}`, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
    ...(method === "POST"
      ? { headers: { "Content-Type": "application/json" }, body: "{}" }
      : {}),
  });
  assert.equal(response.status, expected, `${method} ${path}`);
  await response.body?.cancel();
  console.log(JSON.stringify({ method, path, status: response.status }));
}
console.log(
  "PASS: availability and anonymous auth boundaries; authenticated native acceptance remains a separate gate.",
);
