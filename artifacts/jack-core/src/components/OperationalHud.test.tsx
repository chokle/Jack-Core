// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { customFetch } from "@workspace/api-client-react";
import { createOperationalState, projectFieldState } from "@workspace/api-zod";
import { OperationalHud } from "./OperationalHud";
import { AgentCommandCentre } from "./AgentCommandCentre";

vi.mock("@workspace/api-client-react", () => ({ customFetch: vi.fn() }));
const scope = { userId: "field-one", organizationId: "org-one", siteId: null };
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("operational surfaces", () => {
  it("refreshes the admin mirror and drops privileged controls when authorization fails", async () => {
    vi.useFakeTimers();
    const initial = {
      state: { ...createOperationalState(scope), lifecycle: "working" },
      history: [],
      alerts: [],
      durability: "durable",
      historyTruncated: false,
    };
    vi.mocked(customFetch)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce({
        ...initial,
        state: { ...initial.state, lifecycle: "blocked" },
      })
      .mockRejectedValueOnce({ status: 403 });
    render(<AgentCommandCentre userId={scope.userId} isAdmin />);
    fireEvent.click(screen.getByRole("button", { name: "Command Centre" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText(/Jack: working/)).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(screen.getByText(/Jack: blocked/)).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(screen.queryByRole("button", { name: "Submit command" })).toBeNull();
    expect(screen.queryByText(/Jack: blocked/)).toBeNull();
  });
  it("shares field subscription and renders only Jack even if unexpected internal data arrives", async () => {
    vi.mocked(customFetch).mockResolvedValue({
      ...projectFieldState(createOperationalState(scope)),
      internalAgents: { Dex: { status: "failed" } },
      taskId: "internal-secret",
    });
    render(
      <>
        <OperationalHud userId={scope.userId} />
        <OperationalHud userId={scope.userId} />
      </>,
    );
    await waitFor(() => expect(screen.getAllByText("idle")).toHaveLength(2));
    expect(customFetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(customFetch).mock.calls[0][0]).toBe(
      "/api/operational/state",
    );
    expect(screen.queryByText(/Dex|internal-secret/)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
  it.each([false, undefined])(
    "does not expose admin status or command requests to unresolved/field users (%s)",
    (isAdmin) => {
      render(
        <AgentCommandCentre
          userId={scope.userId}
          isAdmin={isAdmin as boolean}
        />,
      );
      expect(screen.queryByText("Command Centre")).toBeNull();
      expect(customFetch).not.toHaveBeenCalled();
    },
  );
  it("lets admins inspect scoped status and truthfully reports an unconfigured command executor", async () => {
    vi.mocked(customFetch)
      .mockResolvedValueOnce({
        state: {
          ...createOperationalState(scope),
          internalAgents: { Dex: { status: "waiting" } },
        },
        history: [],
        alerts: [],
        durability: "durable",
        historyTruncated: false,
      })
      .mockRejectedValueOnce({ status: 501 });
    const { rerender } = render(
      <AgentCommandCentre userId={scope.userId} isAdmin />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Command Centre" }));
    await screen.findByText("Dex: waiting");
    fireEvent.change(screen.getByLabelText("Internal agent"), {
      target: { value: "Dex" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit command" }));
    await screen.findByText(
      "No internal agent executor is configured. Command was not executed.",
    );
    expect(customFetch).toHaveBeenLastCalledWith(
      "/api/admin/agents/commands",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          permission: "agent.command.run",
          agentId: "Dex",
          channel: "command-centre",
        }),
      }),
    );
    rerender(<AgentCommandCentre userId={scope.userId} isAdmin={false} />);
    expect(screen.queryByText("Dex: waiting")).toBeNull();
  });
});
