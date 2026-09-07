// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JackShell } from "./JackShell";
import type { GraphModel } from "../lib/memory-graph";

vi.mock("./SystemHealthWidget", () => ({ SystemHealthWidget: () => null }));
vi.mock("./SiteHudDemo", () => ({ SiteHudDemo: () => null }));

const model = {
  counts: { nodes: 0, connections: 0, knowledge: 0, topics: 0 },
} as GraphModel;

afterEach(() => cleanup());

function Harness() {
  const [chatOpen, setChatOpen] = useState(false);
  return (
    <>
      <JackShell
        active="graph"
        onNavigate={() => {}}
        onOpenChat={() => setChatOpen(true)}
        model={model}
        readyCount={0}
        lastUpdatedLabel="now"
      >
        <div>Living Memory</div>
      </JackShell>
      {chatOpen && (
        <button aria-label="Close Ask Jack" onClick={() => setChatOpen(false)}>
          Close
        </button>
      )}
      <div data-floating-jack>Radio Jack composer</div>
    </>
  );
}

describe("Ask Jack shell toggle", () => {
  it("uses the same trigger to open and close Ask Jack and suppresses the floating composer while open", async () => {
    render(<Harness />);

    const trigger = screen.getByTestId("open-chat");
    const floatingComposer = screen.getByText("Radio Jack composer");

    expect(screen.queryByLabelText("Close Ask Jack")).toBeNull();
    expect(floatingComposer).not.toHaveAttribute("hidden");

    fireEvent.click(trigger);

    await waitFor(() => expect(screen.getByLabelText("Close Ask Jack")).toBeTruthy());
    await waitFor(() => expect(floatingComposer).toHaveAttribute("hidden"));
    expect(floatingComposer).toHaveAttribute("aria-hidden", "true");

    fireEvent.click(trigger);

    await waitFor(() => expect(screen.queryByLabelText("Close Ask Jack")).toBeNull());
    await waitFor(() => expect(floatingComposer).not.toHaveAttribute("hidden"));
    expect(floatingComposer).toHaveAttribute("aria-hidden", "false");
  });
});
