// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { VideoDetail as VideoDetailData } from "@workspace/api-client-react";
import { VideoDetail } from "./VideoDetail";

/**
 * Closes the timestamp-jump loop the concept inspector starts. The inspector
 * tests (`MemoryGraphView.inspector.test.tsx`) already prove a Source Video /
 * transcript timestamp button calls `onJumpToTimestamp(videoId, startTime)`.
 * App wires that handler to `handleCitationClick`, which selects the video and
 * bumps a `seek` token — so the last, untested link is here: does `VideoDetail`
 * actually drive the <video> element to that moment?
 *
 * A regression that dropped the seek effect, ignored the token, or wired the
 * wrong field would leave the buttons visually present but dead with no failing
 * test. These assert the player's `currentTime` lands on the requested second,
 * both when the media is already ready and when it must wait for metadata, plus
 * that re-clicking the SAME citation (new token, same time) re-seeks.
 *
 * jsdom has no real media element, so `play()` is stubbed and `currentTime` /
 * `readyState` are spy-backed; only the video fetch (`useGetVideo`) is mocked,
 * exactly as the inspector tests mock it.
 */

const videoState = vi.hoisted(() => ({
  data: undefined as VideoDetailData | undefined,
  isLoading: false,
}));

// VideoDetail also pulls `useQueryClient` straight from react-query (for the
// admin delete flow's cache invalidation). Without a QueryClientProvider that
// throws on render, so stub it to an inert client — the seek path never uses it.
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  };
});

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useGetVideo: () => ({ data: videoState.data, isLoading: videoState.isLoading }),
    // Related-video fetch and the processing mutations are inert here — the seek
    // path never touches them, but they must exist so the component renders.
    useFetchRelatedVideos: () => ({ data: [] }),
    useTranscribeVideo: () => ({ mutate: vi.fn(), isPending: false }),
    useAnalyzeVideo: () => ({ mutate: vi.fn(), isPending: false }),
    // Admin video-delete hooks are also inert here — they render unconditionally
    // in VideoDetail but the seek path never uses them.
    useGetMe: () => ({ data: { isAdmin: false } }),
    useDeleteVideo: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

// jsdom's HTMLMediaElement leaves play() unimplemented and currentTime read-only
// in practice; back both with spies so the seek effect can run and be observed.
let currentTimeValue = 0;
let readyStateValue = 1;

beforeEach(() => {
  currentTimeValue = 0;
  readyStateValue = 1;
  videoState.data = undefined;
  videoState.isLoading = false;

  Object.defineProperty(window.HTMLMediaElement.prototype, "currentTime", {
    configurable: true,
    get: () => currentTimeValue,
    set: (v: number) => {
      currentTimeValue = v;
    },
  });
  Object.defineProperty(window.HTMLMediaElement.prototype, "readyState", {
    configurable: true,
    get: () => readyStateValue,
  });
  window.HTMLMediaElement.prototype.play = vi
    .fn()
    .mockResolvedValue(undefined) as unknown as HTMLMediaElement["play"];
});

afterEach(() => {
  cleanup();
});

function makeVideo(overrides: Partial<VideoDetailData> = {}): VideoDetailData {
  return {
    id: "v1",
    title: "Root Pass Demo",
    status: "completed",
    createdAt: "2026-01-02T00:00:00.000Z",
    videoUrl: "https://example.test/v1.mp4",
    ...overrides,
  };
}

const noop = () => {};

describe("VideoDetail — timestamp seek", () => {
  it("shows the unavailable state while a selected video has no response instead of crashing", () => {
    render(<VideoDetail videoId="missing" onBack={noop} onOpenChat={noop} />);

    expect(screen.getByText("This video couldn't be opened")).toBeTruthy();
  });

  it("seeks the player to the cited second when a seek is requested and media is ready", () => {
    videoState.data = makeVideo();

    const { rerender } = render(
      <VideoDetail videoId="v1" onBack={noop} onOpenChat={noop} />,
    );

    // A citation click in the inspector flows here as a new `seek` token.
    rerender(
      <VideoDetail
        videoId="v1"
        onBack={noop}
        onOpenChat={noop}
        seek={{ time: 45, token: 1 }}
      />,
    );

    expect(currentTimeValue).toBe(45);
    expect(window.HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });

  it("waits for loadedmetadata before seeking when the media isn't ready yet", () => {
    videoState.data = makeVideo();
    readyStateValue = 0; // HAVE_NOTHING — no metadata yet.

    const { rerender } = render(
      <VideoDetail videoId="v1" onBack={noop} onOpenChat={noop} />,
    );
    rerender(
      <VideoDetail
        videoId="v1"
        onBack={noop}
        onOpenChat={noop}
        seek={{ time: 30, token: 1 }}
      />,
    );

    // Nothing seeks until the element reports its metadata is loaded.
    expect(currentTimeValue).toBe(0);

    const el = document.querySelector("video")!;
    fireEvent(el, new Event("loadedmetadata"));

    expect(currentTimeValue).toBe(30);
    expect(window.HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });

  it("re-seeks when the same citation is clicked again (new token, same time)", () => {
    videoState.data = makeVideo();

    const { rerender } = render(
      <VideoDetail
        videoId="v1"
        onBack={noop}
        onOpenChat={noop}
        seek={{ time: 12, token: 1 }}
      />,
    );
    expect(currentTimeValue).toBe(12);

    // Simulate the player being scrubbed away, then the same button re-clicked.
    currentTimeValue = 0;
    rerender(
      <VideoDetail
        videoId="v1"
        onBack={noop}
        onOpenChat={noop}
        seek={{ time: 12, token: 2 }}
      />,
    );

    expect(currentTimeValue).toBe(12);
  });

  it("seeks to a transcript segment's start when its row is clicked", () => {
    videoState.data = makeVideo({
      segments: [
        { id: "s1", startTime: 12, endTime: 15, text: "Strike the arc." },
        { id: "s2", startTime: 45, endTime: 49, text: "Angle the rod." },
      ],
    });

    render(<VideoDetail videoId="v1" onBack={noop} onOpenChat={noop} />);

    // Reveal the transcript list, then click the second passage.
    fireEvent.click(screen.getByRole("button", { name: /Transcript/i }));
    fireEvent.click(screen.getByText("Angle the rod."));

    expect(currentTimeValue).toBe(45);
    expect(window.HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });
});
