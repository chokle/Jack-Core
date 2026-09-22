// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DazTaskReport } from "./DazTaskReport";
const authenticatedFetch = vi.hoisted(() => vi.fn());
vi.mock("@workspace/api-client-react", () => ({ authenticatedFetch }));
vi.mock("@clerk/react", () => ({ useAuth: () => ({ userId: "user_1" }) }));
const id = "17fe8057-e179-4483-8d1b-b676b5a490fd";
const key = "jack:daz:health-task:user_1";
const task = {
  task_id: id,
  status: "COMPLETED",
  receipt: { task_id: id, result: "sha256" },
  result: { checks: {} },
  error: null,
};
beforeEach(() => {
  localStorage.clear();
  authenticatedFetch.mockReset();
});
afterEach(() => cleanup());
describe("Daz report tasks", () => {
  it("never submits work on mount", async () => {
    await act(async () => {
      render(<DazTaskReport />);
    });
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });
  it("discards only an invalid saved task pointer without submitting work", async () => {
    localStorage.setItem(key, "------------------------------------");
    localStorage.setItem("unrelated-preference", "preserved");
    await act(async () => {
      render(<DazTaskReport />);
    });
    expect(localStorage.getItem(key)).toBeNull();
    expect(localStorage.getItem("unrelated-preference")).toBe("preserved");
    expect(authenticatedFetch).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Create report" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Retry same task" }),
    ).toBeNull();
  });
  it("normalizes a saved uppercase UUID and retrieves without submitting", async () => {
    localStorage.setItem(key, id.toUpperCase());
    authenticatedFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, task }),
    });
    await act(async () => {
      render(<DazTaskReport />);
    });
    expect(localStorage.getItem(key)).toBe(id);
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
    expect(authenticatedFetch.mock.calls[0][0]).toBe(
      `/api/daz-runtime/tasks/${id}`,
    );
    expect(authenticatedFetch.mock.calls[0][1].method).toBeUndefined();
  });
  it("recovers a saved receipt with GET only after reopening", async () => {
    localStorage.setItem(key, id);
    authenticatedFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, task }),
    });
    await act(async () => {
      render(<DazTaskReport />);
    });
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
    expect(authenticatedFetch.mock.calls[0][0]).toBe(
      `/api/daz-runtime/tasks/${id}`,
    );
    expect(authenticatedFetch.mock.calls[0][1].method).toBeUndefined();
    expect(screen.getByText("Task state: COMPLETED")).toBeTruthy();
  });
  it("saves the ID before submission and uses it again after a network failure", async () => {
    authenticatedFetch.mockImplementation(async (_url, init) => {
      expect(localStorage.getItem(key)).toBe(JSON.parse(init.body).task_id);
      throw new Error("Network interrupted");
    });
    render(<DazTaskReport />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create report" }));
    });
    const saved = localStorage.getItem(key);
    expect(saved).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry same task" }));
    });
    expect(
      authenticatedFetch.mock.calls.map(
        (call) => JSON.parse(call[1].body).task_id,
      ),
    ).toEqual([saved, saved]);
  });
  it("does not claim completion without a receipt", async () => {
    localStorage.setItem(key, id);
    authenticatedFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, task: { ...task, receipt: null } }),
    });
    await act(async () => {
      render(<DazTaskReport />);
    });
    expect(screen.queryByText("Task state: COMPLETED")).toBeNull();
    expect(screen.getByRole("alert")).toBeTruthy();
  });
});
