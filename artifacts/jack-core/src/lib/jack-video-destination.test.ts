import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveJackVideoDestination } from "./jack-video-destination";

const api = vi.hoisted(() => ({ listVideos: vi.fn() }));
vi.mock("@workspace/api-client-react", () => api);
beforeEach(() => api.listVideos.mockReset());
const signal = () => new AbortController().signal;

describe("authorized Library destination lookup", () => {
  it("resolves speech spacing from the authenticated catalog", async () => {
    api.listVideos.mockResolvedValue({
      videos: [{ id: "actual-id", title: "3gdemo" }],
      total: 1,
    });
    const requestSignal = signal();
    expect(await resolveJackVideoDestination("3G demo", requestSignal)).toEqual(
      { kind: "video", id: "actual-id" },
    );
    expect(api.listVideos).toHaveBeenCalledWith(
      { limit: 100, offset: 0 },
      { credentials: "include", signal: requestSignal },
    );
  });
  it("does not select an ambiguous normalized title", async () => {
    api.listVideos.mockResolvedValue({
      videos: [
        { id: "a", title: "3gdemo" },
        { id: "b", title: "3G demo" },
      ],
      total: 2,
    });
    expect((await resolveJackVideoDestination("3G demo", signal())).kind).toBe(
      "ambiguous",
    );
  });
  it("checks later pages before selecting and prefers an exact title", async () => {
    const first = Array.from({ length: 100 }, (_, i) => ({
      id: `${i}`,
      title: `Other ${i}`,
    }));
    first[0].title = "3gdemo advanced";
    api.listVideos
      .mockResolvedValueOnce({ videos: first, total: 101 })
      .mockResolvedValueOnce({
        videos: [{ id: "wanted", title: "3gdemo" }],
        total: 101,
      });
    expect(await resolveJackVideoDestination("3G demo", signal())).toEqual({
      kind: "video",
      id: "wanted",
    });
  });
  it("does not guess from incomplete catalog results", async () => {
    api.listVideos.mockResolvedValue({
      videos: [{ id: "a", title: "3gdemo" }],
      total: 200,
    });
    expect((await resolveJackVideoDestination("3G demo", signal())).kind).toBe(
      "unavailable",
    );
  });
  it("keeps missing names available for graph fallback", async () => {
    api.listVideos.mockResolvedValue({ videos: [], total: 0 });
    expect(await resolveJackVideoDestination("Root Pass", signal())).toEqual({
      kind: "missing",
    });
  });
  it("does not use data delivered after interruption", async () => {
    const controller = new AbortController();
    api.listVideos.mockImplementation(async () => {
      controller.abort();
      return { videos: [{ id: "a", title: "3gdemo" }], total: 1 };
    });
    expect(
      (await resolveJackVideoDestination("3G demo", controller.signal)).kind,
    ).toBe("unavailable");
  });
});
