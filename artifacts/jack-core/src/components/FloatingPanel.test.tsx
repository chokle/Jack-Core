// @vitest-environment jsdom
import { useRef, useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FloatingPanel } from "./FloatingPanel";

function MobileHarness({
  start = "expanded",
}: {
  start?: "expanded" | "minimized";
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"expanded" | "minimized" | "closed">(
    start,
  );

  return (
    <div ref={stageRef} data-testid="stage">
      <output data-testid="state">{state}</output>
      {state !== "closed" && (
        <FloatingPanel
          stageRef={stageRef}
          isDesktop={false}
          state={state}
          onMinimize={() => setState("minimized")}
          onRestore={() => setState("expanded")}
          onClose={() => setState("closed")}
          ariaLabel="Root Pass details"
          headerContent={<span>Root Pass</span>}
          minimizedContent={<span>Root Pass</span>}
        >
          <p>Inspector body</p>
        </FloatingPanel>
      )}
    </div>
  );
}

function ResponsiveHarness() {
  const stageRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"expanded" | "minimized">("expanded");
  const [desktop, setDesktop] = useState(true);
  return (
    <div ref={stageRef} data-testid="responsive-stage">
      <button type="button" onClick={() => setDesktop((value) => !value)}>
        Rotate
      </button>
      <FloatingPanel
        stageRef={stageRef}
        isDesktop={desktop}
        state={state}
        positionKey="responsive-node"
        onMinimize={() => setState("minimized")}
        onRestore={() => setState("expanded")}
        onClose={() => undefined}
        ariaLabel="Responsive node details"
        headerContent={<span>Responsive node</span>}
      >
        <p>Responsive inspector body</p>
      </FloatingPanel>
    </div>
  );
}

afterEach(cleanup);

describe("FloatingPanel mobile inspector states", () => {
  it("uses a compact identity pill to minimize and restore the sheet", () => {
    render(<MobileHarness />);

    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
    expect(screen.getByTestId("state").textContent).toBe("minimized");
    const pill = screen.getByRole("button", {
      name: "Restore Root Pass details",
    });
    expect(pill.getAttribute("data-panel-state")).toBe("minimized");
    expect(pill.textContent).toContain("Root Pass");

    fireEvent.click(pill);
    expect(screen.getByTestId("state").textContent).toBe("expanded");
    expect(screen.getByText("Inspector body")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByTestId("state").textContent).toBe("closed");
  });

  it("keeps the minimized pill docked after a horizontal drag", () => {
    render(<MobileHarness start="minimized" />);
    const pill = screen.getByLabelText("Restore Root Pass details");

    fireEvent.pointerDown(pill, { pointerId: 1, clientX: 200 });
    fireEvent.pointerMove(pill, { pointerId: 1, clientX: 140 });
    fireEvent.pointerUp(pill, { pointerId: 1, clientX: 140 });

    expect(pill.className).toContain("absolute");
    expect(pill.style.touchAction).toBe("none");
    expect(screen.getByTestId("state").textContent).toBe("minimized");
  });

  it("remeasures the desktop panel after minimize/restore and mobile rotation", async () => {
    render(<ResponsiveHarness />);
    await waitFor(() =>
      expect(
        screen.getByRole("dialog", { name: "Responsive node details" }).style
          .visibility,
      ).toBe("visible"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Restore Responsive node details" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("dialog", { name: "Responsive node details" }).style
          .visibility,
      ).toBe("visible"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Rotate" }));
    fireEvent.click(screen.getByRole("button", { name: "Rotate" }));
    await waitFor(() =>
      expect(
        screen.getByRole("dialog", { name: "Responsive node details" }).style
          .visibility,
      ).toBe("visible"),
    );
  });
});
