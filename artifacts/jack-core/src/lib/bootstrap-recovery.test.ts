// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { removeInvalidJsonValues } from "./bootstrap-recovery";

describe("returning-user browser state recovery", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("removes malformed Jack JSON without deleting valid drafts or unrelated auth state", () => {
    localStorage.setItem("jack.interview.resumeNote", "{broken");
    localStorage.setItem(
      "jack.interview.draft.session-1",
      JSON.stringify({ question: "Safe?", text: "Yes" }),
    );
    localStorage.setItem("__clerk_client_jwt", "persisted-auth-token");

    expect(removeInvalidJsonValues(localStorage)).toEqual([
      "jack.interview.resumeNote",
    ]);
    expect(localStorage.getItem("jack.interview.resumeNote")).toBeNull();
    expect(localStorage.getItem("jack.interview.draft.session-1")).not.toBeNull();
    expect(localStorage.getItem("__clerk_client_jwt")).toBe("persisted-auth-token");
  });

  it("cleans malformed session UI state while preserving plain session identifiers", () => {
    sessionStorage.setItem("floating-panel:graph-health", "not-json");
    sessionStorage.setItem("jack.interview.activeSessionId", "session-123");

    expect(removeInvalidJsonValues(sessionStorage)).toEqual([
      "floating-panel:graph-health",
    ]);
    expect(sessionStorage.getItem("jack.interview.activeSessionId")).toBe(
      "session-123",
    );
  });
});

