// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { customFetch } from "@workspace/api-client-react";
import { createOperationalState, projectFieldState } from "@workspace/api-zod";
import { createOperationalSubscription } from "./operational-state";
vi.mock("@workspace/api-client-react", () => ({ customFetch: vi.fn() }));
const state = projectFieldState(
  createOperationalState({
    userId: "one",
    organizationId: "org",
    siteId: null,
  }),
);
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("read-only operational subscription", () => {
  it("clears stale state on fetch failure and aborts when the final consumer leaves", async () => {
    vi.useFakeTimers();
    vi.mocked(customFetch)
      .mockResolvedValueOnce(state)
      .mockRejectedValueOnce(new Error("offline"));
    const store = createOperationalSubscription("one");
    const stop = store.subscribe(vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot().state).toEqual(state);
    await vi.advanceTimersByTimeAsync(3000);
    expect(store.getSnapshot()).toEqual({ state: null, unavailable: true });
    stop();
    await vi.advanceTimersByTimeAsync(6000);
    expect(customFetch).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().state).toBeNull();
  });
  it("rejects another user's response and prevents late requests from restoring signed-out state", async () => {
    vi.useFakeTimers();
    vi.mocked(customFetch).mockResolvedValueOnce(state);
    const store = createOperationalSubscription("another-user");
    const stop = store.subscribe(vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot()).toEqual({ state: null, unavailable: true });
    stop();
    let resolve!: (value: unknown) => void;
    vi.mocked(customFetch).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const live = createOperationalSubscription("one");
    const leave = live.subscribe(vi.fn());
    const signal = vi.mocked(customFetch).mock.calls.at(-1)?.[1]?.signal;
    leave();
    expect(signal?.aborted).toBe(true);
    resolve(state);
    await vi.advanceTimersByTimeAsync(0);
    expect(live.getSnapshot().state).toBeNull();
  });
});
