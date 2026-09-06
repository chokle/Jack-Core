// @vitest-environment jsdom
import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JackShell, type JackView } from "./JackShell";
import { MemoryGraphView } from "./MemoryGraphView";
import { FloatingJack } from "./FloatingJack";
import { VideoDetail } from "./VideoDetail";
import {
  collectJackUiContext,
  type JackUiContext,
} from "../lib/jack-ui-context";
import {
  buildGraphModelFromServer,
  computeVitality,
  EMPTY_DELTA,
} from "../lib/memory-graph";
import type { MemoryGraphData } from "../lib/use-memory-graph";

// This is component integration evidence, not authenticated/live acceptance.
// Shell navigation, graph selection, breadcrumbs, inspector and source actions
// are the production components. Only API responses and canvas drawing are fixtures.
const api = vi.hoisted(() => ({
  askJack: vi.fn(),
  getMe: vi.fn(),
  jumpToSource: vi.fn(),
  openVideo: vi.fn(),
  speechFetch: vi.fn(),
  knowledgeStats: { byTrade: {} },
  onboarding: { preference: { version: 1, status: "completed" } },
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  const mutation = () => ({ mutate: vi.fn(), isPending: false });
  return {
    ...actual,
    askJack: api.askJack,
    getMe: api.getMe,
    useGetMe: () => ({ data: { isAdmin: false } }),
    useGetKnowledgeStats: () => ({ data: api.knowledgeStats }),
    useSetNodeVerification: mutation,
    useRestoreWithdrawnEvidence: mutation,
    useListKnowledgeCandidates: () => ({ data: { candidates: [] } }),
    useListParkedThoughts: () => ({ data: { items: [] } }),
    useResumeParkedThought: mutation,
    useArchiveParkedThought: mutation,
    useGetMemoryGraphOnboardingPreference: () => ({
      data: api.onboarding,
      isSuccess: true,
    }),
    useUpdateMemoryGraphOnboardingPreference: mutation,
    useGetMentorActiveSession: () => ({ data: {} }),
    useGetConceptAnswerContributions: () => ({ data: { contributions: [] } }),
    useGetVideo: (id: string) => ({
      data: {
        id,
        title: id === "v1" ? "Root Pass Demo" : "Fit Up Demo",
        segments: [],
        status: "completed",
        trade: "Welder",
      },
    }),
    useTranscribeVideo: mutation,
    useAnalyzeVideo: mutation,
    useDeleteVideo: mutation,
    useFetchRelatedVideos: () => ({ data: [] }),
  };
});

vi.mock("./SpatialBrainCanvas", async () => {
  const { forwardRef } = await import("react");
  return {
    SpatialBrainCanvas: forwardRef(() => (
      <canvas aria-label="Memory graph canvas" />
    )),
  };
});
vi.mock("./SystemHealthWidget", () => ({ SystemHealthWidget: () => null }));

const model = buildGraphModelFromServer({
  nodes: [
    { id: "__jack__", kind: "core", label: "JACK" },
    { id: "topic:Welder", kind: "topic", label: "Welder", trade: "Welder" },
    {
      id: "concept:root-pass",
      kind: "concept",
      label: "Root Pass",
      trade: "Welder",
      meta: {
        description: "The first deposited weld pass.",
        sources: [{ videoId: "v1", timestamps: [12], confidence: 0.9 }],
      },
    },
    {
      id: "concept:fit-up",
      kind: "concept",
      label: "Fit Up",
      trade: "Welder",
      meta: { sources: [{ videoId: "v2", timestamps: [24], confidence: 0.8 }] },
    },
    { id: "video:v1", kind: "video", label: "Root Pass Demo", trade: "Welder" },
    { id: "video:v2", kind: "video", label: "Fit Up Demo", trade: "Welder" },
  ],
  edges: [
    { id: "e-core", source: "__jack__", target: "topic:Welder", kind: "topic" },
    {
      id: "e-root",
      source: "topic:Welder",
      target: "concept:root-pass",
      kind: "topic",
    },
    {
      id: "e-fit",
      source: "topic:Welder",
      target: "concept:fit-up",
      kind: "topic",
    },
    {
      id: "e-video1",
      source: "topic:Welder",
      target: "video:v1",
      kind: "topic",
    },
    {
      id: "e-video2",
      source: "topic:Welder",
      target: "video:v2",
      kind: "topic",
    },
  ],
});
const graphData: MemoryGraphData = {
  model,
  videos: [],
  competencies: [],
  recent: [],
  readyCount: 2,
  isLoading: false,
  vitality: computeVitality(model),
  delta: EMPTY_DELTA,
};

function Harness() {
  const [active, setActive] = useState<JackView>("graph");
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);
  const [seek, setSeek] = useState<{ time: number; token: number }>();
  return (
    <>
      <JackShell
        active={selectedVideoId ? "library" : active}
        onNavigate={(next) => {
          setSelectedVideoId(null);
          setActive(next);
        }}
        onOpenChat={() => {}}
        model={model}
        readyCount={2}
        lastUpdatedLabel="now"
      >
        {selectedVideoId ? (
          <VideoDetail
            videoId={selectedVideoId}
            onBack={() => setSelectedVideoId(null)}
            onOpenChat={() => {}}
            seek={seek}
          />
        ) : active === "graph" ? (
          <MemoryGraphView
            data={graphData}
            onOpenVideo={(id) => {
              api.openVideo(id);
              setSeek(undefined);
              setSelectedVideoId(id);
            }}
            onJumpToTimestamp={(id, time) => {
              api.jumpToSource(id, time);
              setSelectedVideoId(id);
              setSeek({ time, token: Date.now() });
            }}
            onResumeInterview={() => {}}
            onResumeChat={() => {}}
            onStartInterview={() => {}}
          />
        ) : (
          <h1>Library</h1>
        )}
      </JackShell>
      <FloatingJack />
    </>
  );
}

function HistoryHarness() {
  const [navigation, setNavigation] = useState<{
    entries: JackView[];
    index: number;
  }>({ entries: ["graph"], index: 0 });
  const active = navigation.entries[navigation.index];

  const navigate = (next: JackView) => {
    setNavigation((current) => ({
      entries: [...current.entries.slice(0, current.index + 1), next],
      index: current.index + 1,
    }));
  };

  return (
    <>
      <JackShell
        active={active}
        onNavigate={navigate}
        onOpenChat={() => {}}
        model={model}
        readyCount={2}
        lastUpdatedLabel="now"
        canHistoryBack={navigation.index > 0}
        canHistoryForward={navigation.index < navigation.entries.length - 1}
        onHistoryBack={() =>
          setNavigation((current) => ({
            ...current,
            index: Math.max(0, current.index - 1),
          }))
        }
        onHistoryForward={() =>
          setNavigation((current) => ({
            ...current,
            index: Math.min(current.entries.length - 1, current.index + 1),
          }))
        }
      >
        <section data-testid="history-page">
          <h1>{active}</h1>
        </section>
      </JackShell>
      <FloatingJack />
    </>
  );
}

let queryClient: QueryClient;

async function renderApp() {
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <Harness />
    </QueryClientProvider>,
  );
  await screen.findByRole("textbox", { name: "Ask Jack" });
}

async function renderHistoryApp() {
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <HistoryHarness />
    </QueryClientProvider>,
  );
  await screen.findByRole("textbox", { name: "Ask Jack" });
}

async function selectNode(label: string) {
  const search = screen.getByRole("textbox", {
    name: "Search the memory graph",
  });
  fireEvent.change(search, { target: { value: label } });
  fireEvent.keyDown(search, { key: "Enter" });
  // Flush React/MutationObserver work without waiting for the old 750 ms poll.
  await act(async () => {
    await Promise.resolve();
  });
}

async function submit(message: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "Ask Jack" }), {
    target: { value: message },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send to Jack" }));
  await act(async () => {
    await Promise.resolve();
  });
}

function answerText() {
  return screen.getByRole("button", { name: "Read Jack's answer aloud" })
    .parentElement?.textContent;
}

function awareness() {
  return screen.getByText(/Jack is with you:/).textContent ?? "";
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getMe.mockResolvedValue({});
  api.askJack.mockImplementation((_data, options) => {
    const context = JSON.parse(
      decodeURIComponent(options.headers["X-Jack-Context"]),
    ) as JackUiContext;
    return Promise.resolve({
      answer: `Backend fixture response for ${context.path.join(" > ")}`,
    });
  });
  window.history.replaceState({}, "", "/app");
  document.title = "Jack";
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches:
      query.includes("prefers-reduced-motion") || query.includes("min-width"),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 0),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("fetch", api.speechFetch.mockResolvedValue({ ok: false }));
});

afterEach(() => {
  cleanup();
  queryClient?.clear();
  vi.unstubAllGlobals();
});

describe("Jack Everywhere rendered component acceptance", () => {
  it("sends the actual graph selection, trade and branch with a contextual backend question", async () => {
    await renderApp();
    await selectNode("Welder");
    await selectNode("Root Pass");
    const context = collectJackUiContext();
    expect(context.surface).toBe("Living Memory");
    expect(context.path).toEqual(
      expect.arrayContaining(["Welder", "Root Pass"]),
    );
    expect(context.visibleIds).toContain("concept:root-pass");
    expect(context.visibleIds).toContain("topic:Welder");
    expect(context.visibleIds).not.toContain("concept:fit-up");
    expect(context.inspector.open).toBe(true);
    expect(context.navigation.hasSourceAction).toBe(true);

    await submit("Explain the selected capture in more detail");
    expect(api.askJack).toHaveBeenCalledOnce();
    const sent = JSON.parse(
      decodeURIComponent(
        api.askJack.mock.calls[0][1].headers["X-Jack-Context"],
      ),
    ) as JackUiContext;
    expect(sent.path).toEqual(context.path);
    expect(sent.visibleIds).toContain("concept:root-pass");
    expect(sent.visibleIds).toContain("topic:Welder");
    expect(sent.visibleIds).not.toContain("concept:fit-up");
  });

  it("sends What's this and Where am I to the backend with the selected node and trade", async () => {
    await renderApp();
    await selectNode("Root Pass");
    await submit("What's this?");
    expect(answerText()).toContain("Root Pass");
    await submit("Where am I?");
    expect(answerText()).toContain("Welder");
    expect(answerText()).toContain("Root Pass");
    expect(api.askJack).toHaveBeenCalledTimes(2);
    expect(api.askJack.mock.calls.map(([data]) => data.message)).toEqual([
      "What's this?",
      "Where am I?",
    ]);
    for (const [, options] of api.askJack.mock.calls) {
      const sent = JSON.parse(
        decodeURIComponent(options.headers["X-Jack-Context"]),
      ) as JackUiContext;
      expect(sent.visibleIds).toContain("concept:root-pass");
      expect(sent.path).toEqual(["Jack", "Welder", "Root Pass"]);
    }
  });

  it("opens the selected node's source detail and returns through its actual back action", async () => {
    await renderApp();
    await selectNode("Root Pass");
    await submit("Show me the source");
    expect(api.jumpToSource).toHaveBeenCalledExactlyOnceWith("v1", 12);
    expect(
      screen.getByRole("heading", { name: "Root Pass Demo" }),
    ).toBeTruthy();
    const source = collectJackUiContext();
    expect(source.visibleIds).toContain("v1");
    expect(source.visibleIds).not.toContain("concept:root-pass");
    expect(source.path).toContain("Root Pass Demo");
    await submit("Where am I?");
    expect(answerText()).toContain("Root Pass Demo");
    await submit("Go back");
    expect(collectJackUiContext().surface).toBe("Living Memory");
    expect(collectJackUiContext().visibleIds).not.toContain("v1");
    expect(
      screen.getByRole("textbox", { name: "Search the memory graph" }),
    ).toBeTruthy();
    expect(api.askJack).toHaveBeenCalledOnce();
    expect(api.askJack.mock.calls[0][0].message).toBe("Where am I?");
  });

  it.each(["open the video library", "retrieve from library"])(
    "executes a rendered Library navigation command locally for %s",
    async (message) => {
      await renderApp();
      await selectNode("Root Pass");
      await submit(message);
      expect(awareness()).toContain("Library");
      expect(api.askJack).not.toHaveBeenCalled();
    },
  );

  it("navigates to a named Living Memory node through an app-owned action", async () => {
    await renderApp();
    await submit("Go to the Root Pass node");

    await waitFor(() =>
      expect(collectJackUiContext().path).toContain("Root Pass"),
    );
    const context = collectJackUiContext();
    expect(context.surface).toBe("Living Memory");
    expect(context.path).toContain("Root Pass");
    expect(context.inspector.open).toBe(true);
    expect(context.visibleIds).toContain("concept:root-pass");
    expect(api.askJack).not.toHaveBeenCalled();
  });

  it("executes the exact forward voice wording for a named node", async () => {
    await renderApp();
    await submit("Go forward to the Root Pass node");

    await waitFor(() =>
      expect(collectJackUiContext().path).toContain("Root Pass"),
    );
    expect(collectJackUiContext().inspector.open).toBe(true);
    expect(api.askJack).not.toHaveBeenCalled();
  });

  it("navigates between named app pages locally in both directions", async () => {
    await renderApp();
    await submit("Go to the Library");
    expect(awareness()).toContain("Library");
    await submit("Go to Living Memory");
    await waitFor(() =>
      expect(collectJackUiContext().surface).toBe("Living Memory"),
    );
    expect(api.askJack).not.toHaveBeenCalled();
  });

  it("uses the rendered bounded history target for bare voice forward", async () => {
    await renderHistoryApp();
    await submit("Go to Library");
    expect(collectJackUiContext().surface).toBe("Library");
    await submit("Go to Living Memory");
    expect(collectJackUiContext().surface).toBe("Living Memory");

    await submit("Go back");
    expect(collectJackUiContext().surface).toBe("Library");
    expect(collectJackUiContext().navigation.canForward).toBe(true);

    await submit("Go forward");
    expect(collectJackUiContext().surface).toBe("Living Memory");
    expect(collectJackUiContext().navigation.canForward).toBe(false);
    expect(api.askJack).not.toHaveBeenCalled();
  });

  it("closes the real inspector and then goes up the selected node's breadcrumb", async () => {
    await renderApp();
    await selectNode("Root Pass");
    await submit("Go back");
    expect(collectJackUiContext().inspector.open).toBe(false);
    expect(collectJackUiContext().visibleIds).toContain("concept:root-pass");
    await submit("Go back");
    const after = collectJackUiContext();
    expect(after.surface).toBe("Living Memory");
    expect(after.path).toContain("Welder");
    expect(after.path).not.toContain("Root Pass");
    expect(after.visibleIds).not.toContain("concept:root-pass");
    expect(api.askJack).not.toHaveBeenCalled();
  });

  it("updates awareness on selection immediately and uses the new node's source", async () => {
    await renderApp();
    await selectNode("Root Pass");
    expect(awareness()).toContain("Root Pass");
    await selectNode("Fit Up");
    expect(awareness()).toContain("Fit Up");
    expect(awareness()).not.toContain("Root Pass");
    const context = collectJackUiContext();
    expect(context.visibleIds).toContain("concept:fit-up");
    expect(context.visibleIds).not.toContain("concept:root-pass");
    await submit("Show me the source");
    expect(api.jumpToSource).toHaveBeenCalledExactlyOnceWith("v2", 24);
  });

  it("drops selected graph state and the visible answer when real shell navigation changes surface", async () => {
    await renderApp();
    await selectNode("Root Pass");
    await submit("What's this?");
    expect(answerText()).toContain("Root Pass");
    fireEvent.click(screen.getByRole("button", { name: "Library" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(awareness()).toContain("Library");
    expect(awareness()).not.toContain("Root Pass");
    expect(
      screen.queryByRole("button", { name: "Read Jack's answer aloud" }),
    ).toBeNull();
    const context = collectJackUiContext();
    expect(context.visibleIds).not.toContain("concept:root-pass");
    expect(context.inspector.open).toBe(false);
    expect(context.navigation.hasSourceAction).toBe(false);
  });

  it("does not display or speak an old-context response after selection changes", async () => {
    let resolveOld!: (response: { answer: string }) => void;
    api.askJack.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    await renderApp();
    await selectNode("Root Pass");
    await submit("Explain the selected capture in more detail");
    expect(api.askJack).toHaveBeenCalledOnce();
    await selectNode("Fit Up");
    await act(async () => {
      resolveOld({ answer: "Obsolete answer for Root Pass" });
    });
    expect(screen.queryByText("Obsolete answer for Root Pass")).toBeNull();
    expect(api.speechFetch).not.toHaveBeenCalled();
    expect(awareness()).toContain("Fit Up");
    await submit("What's this?");
    await waitFor(() => expect(answerText()).toContain("Fit Up"));
  });
});
