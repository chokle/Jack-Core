// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PilotOrientation } from "./PilotOrientation";

afterEach(cleanup);
beforeEach(() => window.sessionStorage.clear());

const baseProps = {
  userId: "worker-1",
  activeView: "orientation" as const,
  onOpenOrientation: vi.fn(),
  onOpenRadar: vi.fn(),
  onOpenCloseout: vi.fn(),
  onFinish: vi.fn(),
  canOpenCloseout: true,
};

describe("PilotOrientation", () => {
  it("uses Jack and routes the tour through Dashboard and closeout", () => {
    const props = {
      ...baseProps,
      onOpenRadar: vi.fn(),
      onOpenCloseout: vi.fn(),
    };
    const { rerender } = render(<PilotOrientation {...props} />);
    expect(screen.getByRole("img", { name: "Jack" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(screen.queryByLabelText(/pointing hand/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Ask Jack" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(props.onOpenRadar).toHaveBeenCalledOnce();
    rerender(<PilotOrientation {...props} activeView="dashboard" />);
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    expect(screen.getByText(/Dashboard is your site workspace/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(props.onOpenCloseout).toHaveBeenCalledOnce();

    rerender(<PilotOrientation {...props} activeView="closeout" />);
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    expect(
      screen.getByText(/where you leave your shift handover/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Finish guide" }));
    expect(props.onFinish).toHaveBeenCalledOnce();
  });

  it("keeps closeout out of the route for accounts without participant access", () => {
    const props = {
      ...baseProps,
      canOpenCloseout: false,
      onOpenRadar: vi.fn(),
    };
    const { rerender } = render(<PilotOrientation {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    rerender(<PilotOrientation {...props} activeView="dashboard" />);
    fireEvent.click(screen.getByRole("button", { name: "Finish guide" }));
    expect(props.onOpenCloseout).not.toHaveBeenCalled();
  });

  it("restores the current step for the same signed-in user", () => {
    const first = render(<PilotOrientation {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    first.unmount();
    render(<PilotOrientation {...baseProps} activeView="dashboard" />);
    expect(screen.getByText(/This is Site Radar/)).toBeTruthy();
  });
});
