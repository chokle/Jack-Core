import { afterEach, describe, expect, it, vi } from "vitest";
import { requestDazTask } from "../daz-tasks.js";
const id = "17fe8057-e179-4483-8d1b-b676b5a490fd";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
function config() {
  vi.stubEnv("DAZ_RUNTIME_URL", "https://runtime.example");
  vi.stubEnv("DAZ_RUNTIME_TOKEN", "private-service-token");
}
describe("Daz task transport", () => {
  it("rejects redirects and scopes retrieval to the server identity", async () => {
    config();
    const fake = vi.fn().mockResolvedValue(new Response("{}", { status: 302 }));
    await expect(requestDazTask(id, "user_1", false, fake)).rejects.toThrow();
    expect(fake.mock.calls[0][0].searchParams.get("requested_by")).toBe(
      "user_1",
    );
    expect(fake.mock.calls[0][1]).toMatchObject({
      redirect: "error",
      method: "GET",
      headers: { authorization: "Bearer private-service-token" },
    });
  });
  it("times out a hung request", async () => {
    config();
    const fake = vi.fn(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) =>
          init.signal.addEventListener("abort", () =>
            reject(new Error("aborted")),
          ),
        ),
    );
    await expect(requestDazTask(id, "user_1", true, fake, 10)).rejects.toThrow(
      "aborted",
    );
  });
  it("rejects a mismatched requester and completion without durable evidence", async () => {
    config();
    const task = {
      task_id: id,
      kind: "jack_health_report",
      requested_by: "user_1",
      status: "COMPLETED",
      created_at: "now",
      updated_at: "now",
      attempts: 1,
      result: null,
      receipt: null,
      error: null,
    };
    const fake = vi
      .fn()
      .mockImplementation(async () => Response.json({ ok: true, task }));
    await expect(requestDazTask(id, "user_1", false, fake)).rejects.toThrow(
      "Invalid task provenance",
    );
    task.status = "PROPOSED";
    task.requested_by = "other";
    await expect(requestDazTask(id, "user_1", false, fake)).rejects.toThrow(
      "Invalid task provenance",
    );
  });
});
