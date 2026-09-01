// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listPendingRecordings,
  uploadTestRecording,
  type TestRecordingMetadata,
} from "./upload-service";

const fetchMock = vi.fn();
const createObjectUrlSpy = vi.fn(() => "blob:recording");
const revokeObjectUrlSpy = vi.fn();

function metadata(identityKey = "user-a"): TestRecordingMetadata {
  return {
    sessionId: "11111111-1111-4111-8111-111111111111",
    timestamp: "2026-08-31T00:00:00.000Z",
    durationMs: 2_000,
    mimeType: "video/webm",
    microphoneIncluded: false,
    identityKey,
  };
}

describe("uploadTestRecording identity boundary", () => {
  beforeEach(() => {
    window.localStorage.clear();
    fetchMock.mockReset();
    createObjectUrlSpy.mockClear();
    revokeObjectUrlSpy.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", {
      createObjectURL: createObjectUrlSpy,
      revokeObjectURL: revokeObjectUrlSpy,
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("cancels an aborted in-flight upload without persistence or download", async () => {
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    const controller = new AbortController();
    fetchMock.mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal as AbortSignal;
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );

    const pending = uploadTestRecording(
      new Blob(["recording"], { type: "video/webm" }),
      metadata(),
      { signal: controller.signal },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(request.signal).toBe(controller.signal);
    controller.abort();

    await expect(pending).resolves.toEqual({ status: "cancelled" });
    expect(clickSpy).not.toHaveBeenCalled();
    expect(createObjectUrlSpy).not.toHaveBeenCalled();
    expect(listPendingRecordings("user-a")).toEqual([]);
    expect(listPendingRecordings()).toEqual([]);
  });

  it("fails closed when the identity becomes stale before a failed request settles", async () => {
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    let rejectUpload: ((reason?: unknown) => void) | undefined;
    let isCurrentIdentity = true;
    fetchMock.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectUpload = reject;
        }),
    );

    const pending = uploadTestRecording(
      new Blob(["recording"], { type: "video/webm" }),
      metadata(),
      { shouldFallback: () => isCurrentIdentity },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    isCurrentIdentity = false;
    rejectUpload?.(new Error("network unavailable"));

    await expect(pending).resolves.toEqual({ status: "cancelled" });
    expect(clickSpy).not.toHaveBeenCalled();
    expect(createObjectUrlSpy).not.toHaveBeenCalled();
    expect(listPendingRecordings("user-a")).toEqual([]);
    expect(listPendingRecordings("user-b")).toEqual([]);
    expect(listPendingRecordings()).toEqual([]);
  });

  it("stores ordinary upload failures only for the active identity", async () => {
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    fetchMock.mockResolvedValue({ ok: false, status: 503 });

    const outcome = await uploadTestRecording(
      new Blob(["recording"], { type: "video/webm" }),
      metadata(),
      { shouldFallback: () => true },
    );

    expect(outcome).toMatchObject({
      status: "saved-locally",
      filename: "jack-user-test-11111111-1111-4111-8111-111111111111.webm",
    });
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(createObjectUrlSpy).toHaveBeenCalledTimes(1);
    expect(listPendingRecordings("user-a")).toEqual([metadata()]);
    expect(listPendingRecordings("user-b")).toEqual([]);
    expect(listPendingRecordings()).toEqual([]);

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const form = request.body as FormData;
    expect(form.has("identityKey")).toBe(false);
  });
});
