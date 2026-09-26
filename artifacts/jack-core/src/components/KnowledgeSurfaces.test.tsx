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
    edges: [{ a: "concept:weld", b: "comp:W-1", kind: "competency" }],
    nodes: [
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
    render(
      <CompetenciesView
        data={data}
        onOpenVideo={onOpenVideo}
        onOpenGraph={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Prepare welds/ }));
    expect(screen.getByText("Clean metal before welding")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Weld setup" }));
    expect(onOpenVideo).toHaveBeenCalledWith("video-1");
    expect(screen.getByText(/not a rating of any worker/)).toBeTruthy();
  });

  it("shows a finding only with a real source and opens its evidence", () => {
    const onOpenVideo = vi.fn();
    render(<InsightsView data={data} onOpenVideo={onOpenVideo} />);
    expect(screen.getByText("Clean metal before welding")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Weld setup/ }));
    expect(onOpenVideo).toHaveBeenCalledWith("video-1");
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
