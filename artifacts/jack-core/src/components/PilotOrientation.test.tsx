// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PilotOrientation } from "./PilotOrientation";

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

describe("PilotOrientation", () => {
  it("opens Ask Jack with a question and links to live site and closeout", () => {
    const onAskJack = vi.fn();
    const onOpenDashboard = vi.fn();
    const onOpenCloseout = vi.fn();
    render(
      <PilotOrientation
        onAskJack={onAskJack}
        onOpenDashboard={onOpenDashboard}
        onOpenCloseout={onOpenCloseout}
        onFinish={vi.fn()}
        canOpenCloseout
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Ask Jack" }));
    expect(screen.queryByRole("button", { name: "Open Dashboard" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    fireEvent.click(screen.getByRole("button", { name: "Finish guide" }));
    expect(onAskJack).toHaveBeenCalledWith(
      expect.stringContaining("What is Torch"),
    );
    expect(onOpenDashboard).toHaveBeenCalledOnce();
    expect(onOpenCloseout).toHaveBeenCalledOnce();
  });

  it("does not offer closeout to an administrator", () => {
    render(
      <PilotOrientation
        onAskJack={vi.fn()}
        onOpenDashboard={vi.fn()}
        onOpenCloseout={vi.fn()}
        onFinish={vi.fn()}
        canOpenCloseout={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.queryByRole("button", { name: "Open Closeout" })).toBeNull();
  });

  it("preserves the active step while Ask Jack covers the guide", () => {
    const props = {
      onAskJack: vi.fn(),
      onOpenDashboard: vi.fn(),
      onOpenCloseout: vi.fn(),
      onFinish: vi.fn(),
      canOpenCloseout: true,
    };
    const visit = render(<PilotOrientation {...props} />);
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    visit.rerender(<PilotOrientation {...props} chatOpen />);
    expect(screen.queryByRole("progressbar")).toBeNull();
    visit.rerender(<PilotOrientation {...props} />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "2",
    );
  });

  it("keeps navigation and a direct return on the real destination", () => {
    const onReturnToGuide = vi.fn();
    const props = {
      userId: "destination-worker",
      onAskJack: vi.fn(),
      onOpenDashboard: vi.fn(),
      onOpenCloseout: vi.fn(),
      onFinish: vi.fn(),
      onReturnToGuide,
      canOpenCloseout: true,
    };
    const visit = render(<PilotOrientation {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    visit.rerender(<PilotOrientation {...props} surface="dashboard" />);
    expect(
      screen.getByRole("complementary", { name: "Jack onboarding guide" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Return to guide" }));
    expect(onReturnToGuide).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    visit.rerender(<PilotOrientation {...props} surface="closeout" />);
    fireEvent.click(screen.getByRole("button", { name: "Finish guide" }));
    expect(props.onFinish).toHaveBeenCalledOnce();
  });

  it("resumes the same signed-in user's step after leaving and returning", () => {
    const props = {
      userId: "worker-1",
      onAskJack: vi.fn(),
      onOpenDashboard: vi.fn(),
      onOpenCloseout: vi.fn(),
      onFinish: vi.fn(),
      canOpenCloseout: true,
    };
    const firstVisit = render(<PilotOrientation {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("button", { name: "Open Dashboard" })).toBeTruthy();
    firstVisit.unmount();

    render(<PilotOrientation {...props} />);
    expect(screen.getByRole("button", { name: "Open Dashboard" })).toBeTruthy();
  });
});
