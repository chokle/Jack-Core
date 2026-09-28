// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PilotOrientation } from "./PilotOrientation";

afterEach(cleanup);

describe("PilotOrientation", () => {
  it("opens Ask Jack with a question and links to live site and closeout", () => {
    const onAskJack = vi.fn();
    const onOpenRadar = vi.fn();
    const onOpenCloseout = vi.fn();
    render(
      <PilotOrientation
        onAskJack={onAskJack}
        onOpenRadar={onOpenRadar}
        onOpenCloseout={onOpenCloseout}
        onFinish={vi.fn()}
        canOpenCloseout
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Ask Jack" }));
    expect(
      screen.queryByRole("button", { name: "Open Site Radar" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Next: get familiar with the site" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Open Site Radar" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Next: hand over your shift" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Open Closeout" }));
    fireEvent.click(screen.getByRole("button", { name: "Finish guide" }));
    expect(onAskJack).toHaveBeenCalledWith(
      expect.stringContaining("What is Torch"),
    );
    expect(onOpenRadar).toHaveBeenCalledOnce();
    expect(onOpenCloseout).toHaveBeenCalledOnce();
  });

  it("does not offer closeout to an administrator", () => {
    render(
      <PilotOrientation
        onAskJack={vi.fn()}
        onOpenRadar={vi.fn()}
        onOpenCloseout={vi.fn()}
        onFinish={vi.fn()}
        canOpenCloseout={false}
      />,
    );
    expect(screen.queryByRole("button", { name: "Open Closeout" })).toBeNull();
  });
});
