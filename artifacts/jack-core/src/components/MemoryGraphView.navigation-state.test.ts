import { describe, expect, it } from "vitest";
import {
  INITIAL_GRAPH_INSPECTOR_STATE,
  graphInspectorReducer,
} from "./MemoryGraphView";

describe("MemoryGraphView graph and inspector state", () => {
  it("minimizes, closes, and restores details without clearing graph context", () => {
    const opened = graphInspectorReducer(INITIAL_GRAPH_INSPECTOR_STATE, {
      type: "open-graph-node",
      id: "topic:Welder",
      kind: "topic",
    });
    const minimized = graphInspectorReducer(opened, { type: "minimize" });
    const closed = graphInspectorReducer(minimized, { type: "close" });
    const restored = graphInspectorReducer(closed, { type: "restore" });

    expect(minimized).toMatchObject({
      activeGraphId: "topic:Welder",
      branchId: "topic:Welder",
      inspectorNodeId: "topic:Welder",
      visibility: "minimized",
    });
    expect(closed).toMatchObject({
      activeGraphId: "topic:Welder",
      branchId: "topic:Welder",
      inspectorNodeId: "topic:Welder",
      visibility: "closed",
    });
    expect(restored).toMatchObject({
      activeGraphId: "topic:Welder",
      branchId: "topic:Welder",
      inspectorNodeId: "topic:Welder",
      visibility: "expanded",
    });
  });

  it("opens node B while preserving node A's active branch", () => {
    const branchA = graphInspectorReducer(INITIAL_GRAPH_INSPECTOR_STATE, {
      type: "open-graph-node",
      id: "topic:Welder",
      kind: "topic",
    });
    const nodeA = graphInspectorReducer(branchA, {
      type: "open-graph-node",
      id: "concept:root-pass",
      kind: "concept",
    });
    const nodeB = graphInspectorReducer(nodeA, {
      type: "open-in-current-branch",
      id: "mentor:mentor-b",
    });

    expect(nodeB).toMatchObject({
      activeGraphId: "mentor:mentor-b",
      branchId: "topic:Welder",
      inspectorNodeId: "mentor:mentor-b",
      visibility: "expanded",
    });
  });
});
