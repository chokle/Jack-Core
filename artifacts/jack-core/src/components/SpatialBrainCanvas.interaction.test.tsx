// @vitest-environment jsdom
import { createRef, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildGraphModelFromServer,
  CORE_ID,
  type GraphModel,
} from "../lib/memory-graph";
import {
  SpatialBrainCanvas,
  type MemoryGraphHandle,
} from "./SpatialBrainCanvas";

vi.mock("../hooks/use-system-health", () => ({
  useSystemHealth: () => ({
    snapshot: { pulseColor: "green" },
    isOffline: false,
  }),
}));
vi.mock("../lib/motion", () => ({ ambientMotionEnabled: () => false }));

const TRADE_ID = "topic:Welder";
const CHILD_ID = "concept:root-pass";
const canvasRect = { left: 0, top: 0, width: 412, height: 640 } as DOMRect;
let frames: Map<number, FrameRequestCallback>;
let nextFrameId: number;
let frameTime: number;

function modelWithChild(label?: string): GraphModel {
  return buildGraphModelFromServer({
    nodes: [
      { id: CORE_ID, kind: "core", label: "JACK" },
      { id: TRADE_ID, kind: "topic", label: "Welder", trade: "Welder" },
      ...(label
        ? [{ id: CHILD_ID, kind: "concept", label, trade: "Welder" }]
        : []),
    ],
    edges: [
      { id: "core-trade", source: CORE_ID, target: TRADE_ID, kind: "topic" },
      ...(label
        ? [
            {
              id: "trade-child",
              source: TRADE_ID,
              target: CHILD_ID,
              kind: "knowledge",
            },
          ]
        : []),
    ],
  });
}

/** Run the real layout/projection loop; only canvas painting is a no-op. */
function settleGraph() {
  act(() => {
    for (let i = 0; i < 120; i++) {
      frameTime += 16.67;
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(frameTime));
    }
  });
}

function pointer(
  canvas: HTMLCanvasElement,
  type: "pointerdown" | "pointerup" | "pointercancel",
  position: { x: number; y: number },
  pointerType = "touch",
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    clientX: position.x,
    clientY: position.y,
  });
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    pointerType: { value: pointerType },
  });
  fireEvent(canvas, event);
}

beforeEach(() => {
  frames = new Map();
  nextFrameId = 0;
  frameTime = performance.now();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++nextFrameId;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const noop = () => {};
  const gradient = () => ({ addColorStop: noop });
  const context = {
    setTransform: noop,
    createLinearGradient: gradient,
    createRadialGradient: gradient,
    fillRect: noop,
    save: noop,
    restore: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    fill: noop,
    stroke: noop,
    fillText: noop,
    setLineDash: noop,
  } as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
  vi.spyOn(
    HTMLCanvasElement.prototype,
    "getBoundingClientRect",
  ).mockReturnValue(canvasRect);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SpatialBrainCanvas rendered pointer lifecycle", () => {
  it.each(["touch", "mouse"])(
    "selects hydrated children and refreshed node data with %s without remounting",
    (pointerType) => {
      const handle = createRef<MemoryGraphHandle>();
      const onZoomChange = vi.fn();
      function Graph({ model }: { model: GraphModel }) {
        const [selected, setSelected] = useState<string | null>(null);
        // Match MemoryGraphView: each model creates a new lookup and selection
        // callback. The initial lookup contains hubs but no hydrated children.
        const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
        return (
          <>
            <SpatialBrainCanvas
              ref={handle}
              model={model}
              selectedId={null}
              branchId={TRADE_ID}
              viewMode="branches"
              onSelect={(id) => {
                const node = id ? nodeById.get(id) : undefined;
                if (node) setSelected(node.label);
              }}
              search=""
              locked={false}
              onZoomChange={onZoomChange}
            />
            <output aria-label="Selected node">{selected}</output>
          </>
        );
      }
      const { container, rerender } = render(
        <Graph model={modelWithChild()} />,
      );
      const canvas = container.querySelector("canvas")!;
      const tap = (id: string) => {
        const position = handle.current!.getScreenPos(id);
        expect(position).not.toBeNull();
        pointer(canvas, "pointerdown", position!, pointerType);
        pointer(canvas, "pointerup", position!, pointerType);
      };

      settleGraph();
      tap(TRADE_ID);
      expect(screen.getByLabelText("Selected node").textContent).toBe("Welder");
      expect(handle.current!.getScreenPos(CHILD_ID)).toBeNull();

      rerender(<Graph model={modelWithChild("Root Pass")} />);
      settleGraph();
      expect(container.querySelector("canvas")).toBe(canvas);
      tap(CHILD_ID);
      expect(screen.getByLabelText("Selected node").textContent).toBe(
        "Root Pass",
      );

      // A later query refresh must use the latest node record too.
      rerender(<Graph model={modelWithChild("Root Pass — reviewed")} />);
      settleGraph();
      tap(CHILD_ID);
      expect(screen.getByLabelText("Selected node").textContent).toBe(
        "Root Pass — reviewed",
      );
    },
  );

  it("does not select a cancelled touch on a later release, then accepts a fresh tap", () => {
    const handle = createRef<MemoryGraphHandle>();
    const onSelect = vi.fn();
    const { container } = render(
      <SpatialBrainCanvas
        ref={handle}
        model={modelWithChild("Root Pass")}
        selectedId={null}
        branchId={TRADE_ID}
        viewMode="branches"
        onSelect={onSelect}
        search=""
        locked={false}
        onZoomChange={vi.fn()}
      />,
    );
    settleGraph();
    const canvas = container.querySelector("canvas")!;
    const position = handle.current!.getScreenPos(CHILD_ID)!;
    expect(position).not.toBeNull();

    pointer(canvas, "pointerdown", position);
    pointer(canvas, "pointercancel", position);
    pointer(canvas, "pointerup", position);
    expect(onSelect).not.toHaveBeenCalled();

    pointer(canvas, "pointerdown", position);
    pointer(canvas, "pointerup", position);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(CHILD_ID);
  });
});
