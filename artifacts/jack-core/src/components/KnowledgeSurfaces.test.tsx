// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { MemoryGraphData } from "../lib/use-memory-graph";
import { CompetenciesView } from "./CompetenciesView";
import { InsightsView } from "./InsightsView";
import { Dashboard } from "./Dashboard";

afterEach(cleanup);

const data = {
  isLoading: false,
  hasError: false,
  competencies: [{ code: "W-1", name: "Prepare welds", trade: "Welder" }],
  videos: [
    {
      id: "video-1",
      title: "Weld setup",
      status: "completed",
      competencyCodes: ["W-1"],
    },
  ],
  model: {
    counts: { nodes: 3, connections: 2, topics: 1, videos: 1, knowledge: 1 },
    topics: [
      {
        id: "topic:Welder",
        label: "Welder",
        trade: "Welder",
        metrics: { knowledge: 1, videos: 1 },
      },
    ],
    edges: [
      { a: "concept:weld", b: "comp:W-1", kind: "competency" },
      { a: "video:video-1", b: "comp:W-1", kind: "competency" },
    ],
    nodes: [
      {
        id: "video:video-1",
        kind: "video",
        label: "Weld setup",
        status: "completed",
        meta: {},
      },
      {
        id: "concept:weld",
        kind: "concept",
        label: "Clean metal before welding",
        meta: {
          trade: "Welder",
          sourceCount: 1,
          sources: [{ videoId: "video-1", timestamps: [63], confidence: 0.8 }],
        },
      },
    ],
  },
} as unknown as MemoryGraphData;

describe("knowledge surfaces", () => {
  it("connects a Red Seal competency to graph knowledge and processed videos", () => {
    const onOpenVideo = vi.fn();
    const onOpenGraph = vi.fn();
    render(
      <CompetenciesView
        data={data}
        onOpenVideo={onOpenVideo}
        onOpenGraph={onOpenGraph}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Prepare welds/ }));
    expect(screen.getByText("Clean metal before welding")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Weld setup" }));
    expect(onOpenVideo).toHaveBeenCalledWith("video-1");
    fireEvent.click(screen.getByRole("button", { name: "Open Living Memory" }));
    expect(onOpenGraph).toHaveBeenCalledWith("comp:W-1");
    expect(screen.getByText(/not a rating of any worker/)).toBeTruthy();
  });

  it("shows a finding only with a real source and opens its evidence", () => {
    const onJumpToTimestamp = vi.fn();
    const onOpenGraph = vi.fn();
    render(
      <InsightsView
        data={data}
        onJumpToTimestamp={onJumpToTimestamp}
        onOpenGraph={onOpenGraph}
      />,
    );
    expect(screen.getByText("Clean metal before welding")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Weld setup/ }));
    expect(onJumpToTimestamp).toHaveBeenCalledWith("video-1", 63);
    fireEvent.click(
      screen.getByRole("button", { name: "Open provenance in Living Memory" }),
    );
    expect(onOpenGraph).toHaveBeenCalledWith("concept:weld");
  });

  it("uses persisted graph evidence beyond the first video page", () => {
    const graphOnly = { ...data, videos: [] } as MemoryGraphData;
    render(
      <InsightsView
        data={graphOnly}
        onJumpToTimestamp={vi.fn()}
        onOpenGraph={vi.fn()}
      />,
    );
    expect(screen.getByText("Clean metal before welding")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Weld setup/ })).toBeTruthy();
  });

  it("reports graph failure without presenting missing links as an empty result", () => {
    render(
      <CompetenciesView
        data={{ ...data, graphError: true }}
        onOpenVideo={vi.fn()}
        onOpenGraph={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Prepare welds/ }));
    expect(screen.getByRole("alert").textContent).toMatch(
      /could not be loaded/,
    );
    expect(
      screen.queryByText("No Living Memory knowledge is linked yet."),
    ).toBeNull();
  });

  it("keeps interview-backed knowledge visible without naming or scoring a worker", () => {
    const mentorData = {
      ...data,
      model: {
        ...data.model,
        nodes: [
          {
            ...data.model.nodes[0],
            meta: { trade: "Welder", sourceCount: 1, sources: [] },
          },
          {
            id: "mentor:one",
            kind: "mentor",
            label: "Private mentor",
            meta: {},
          },
        ],
        edges: [{ a: "concept:weld", b: "mentor:one", kind: "mentor" }],
      },
    } as unknown as MemoryGraphData;
    render(
      <InsightsView
        data={mentorData}
        onJumpToTimestamp={vi.fn()}
        onOpenGraph={vi.fn()}
      />,
    );
    expect(screen.getByText("Clean metal before welding")).toBeTruthy();
    expect(screen.getByText(/1 interview contribution/)).toBeTruthy();
    expect(screen.queryByText("Private mentor")).toBeNull();
  });

  it("uses observed counts without invented coverage scores", () => {
    render(
      <Dashboard model={data.model} readyCount={1} lastUpdatedLabel="now" />,
    );
    expect(screen.getByText("Trade knowledge")).toBeTruthy();
    expect(screen.queryByText(/Concept density/)).toBeNull();
    expect(screen.queryByText(/Processed source coverage/)).toBeNull();
  });
});
