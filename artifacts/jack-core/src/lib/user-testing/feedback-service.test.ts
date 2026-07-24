// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FEEDBACK_COOLDOWN_MS,
  getFeedbackActivity,
  isFeedbackEligible,
  isTopBoundaryExit,
  isTouchOrMobileDevice,
  markFeedbackFeature,
  markFeedbackPrompted,
  readFeedbackDraft,
  saveFeedbackDraft,
} from "./feedback-service";

describe("user-test feedback eligibility", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 0 });
    window.matchMedia = vi.fn().mockReturnValue({ matches: false });
  });

  it("requires consent, an authenticated tester, meaningful activity, and session age", () => {
    const now = 100_000;
    const activity = markFeedbackFeature("ask_jack", 1_000);
    expect(isFeedbackEligible({ consented: true, userId: "user_1", now, activity })).toBe(true);
    expect(isFeedbackEligible({ consented: false, userId: "user_1", now, activity })).toBe(false);
    expect(isFeedbackEligible({ consented: true, userId: "presentation-demo", now, activity })).toBe(false);
    expect(
      isFeedbackEligible({
        consented: true,
        userId: "user_1",
        now: 2_000,
        activity,
      }),
    ).toBe(false);
  });

  it("deduplicates prompts during the seven-day cooldown", () => {
    const activity = markFeedbackFeature("interview_mode", 1_000);
    markFeedbackPrompted("user_1", 50_000);
    expect(
      isFeedbackEligible({ consented: true, userId: "user_1", now: 50_001, activity }),
    ).toBe(false);
    expect(
      isFeedbackEligible({
        consented: true,
        userId: "user_1",
        now: 50_000 + FEEDBACK_COOLDOWN_MS + 1,
        activity,
      }),
    ).toBe(true);
  });

  it("only recognizes a top-boundary desktop exit", () => {
    expect(isTopBoundaryExit({ clientY: 0, relatedTarget: null })).toBe(true);
    expect(isTopBoundaryExit({ clientY: 300, relatedTarget: null })).toBe(false);
    expect(isTopBoundaryExit({ clientY: 0, relatedTarget: document.body })).toBe(false);
  });

  it("disables exit intent on touch/mobile devices", () => {
    Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 1 });
    expect(isTouchOrMobileDevice()).toBe(true);
  });

  it("preserves partial answers locally", () => {
    const draft = {
      feedbackId: crypto.randomUUID(),
      goal: "Find a procedure",
      useful: "" as const,
      shortfall: "",
      adoptionNeed: "",
      additional: "",
    };
    saveFeedbackDraft("user_1", draft);
    expect(readFeedbackDraft("user_1")).toEqual(draft);
    expect(getFeedbackActivity().sessionId).toBeTruthy();
  });
});
