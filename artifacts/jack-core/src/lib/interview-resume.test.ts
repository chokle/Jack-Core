// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVE_INTERVIEW_SESSION_KEY,
  handoffInterviewResume,
} from "./interview-resume";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("interview resume handoff", () => {
  it("stores the exact server-returned session id", () => {
    const openInterview = vi.fn();
    expect(handoffInterviewResume("server-session-8", openInterview)).toBe(
      true,
    );
    expect(sessionStorage.getItem(ACTIVE_INTERVIEW_SESSION_KEY)).toBe(
      "server-session-8",
    );
    expect(openInterview).toHaveBeenCalledOnce();
  });

  it("keeps the recovery surface open when browser storage is unavailable", () => {
    const openInterview = vi.fn();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("storage unavailable");
    });

    expect(handoffInterviewResume("server-session-8", openInterview)).toBe(
      false,
    );
    expect(sessionStorage.getItem(ACTIVE_INTERVIEW_SESSION_KEY)).toBeNull();
    expect(openInterview).not.toHaveBeenCalled();
  });
});
