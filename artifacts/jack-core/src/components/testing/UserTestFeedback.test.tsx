// @vitest-environment jsdom
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  UserTestFeedback,
  type UserTestFeedbackHandle,
} from "./UserTestFeedback";
import { markFeedbackFeature } from "@/lib/user-testing/feedback-service";

const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

function renderFeedback(onContinue = vi.fn()) {
  const ref = createRef<UserTestFeedbackHandle>();
  render(
    <UserTestFeedback
      ref={ref}
      consented
      userId="user_1"
      now={() => 100_000}
      minimumSessionMs={0}
      requestTimeoutMs={50}
    />,
  );
  act(() => {
    ref.current!.markFeature("ask_jack");
    ref.current!.request("logout", onContinue);
  });
  return { ref, onContinue };
}

function fillRequiredAnswers() {
  fireEvent.change(
    screen.getByLabelText("1. What did you try to accomplish with Jack today?"),
    { target: { value: "Find a safe procedure" } },
  );
  fireEvent.click(screen.getByLabelText(/partly/i));
  fireEvent.change(screen.getByLabelText("3. Where did Jack fall short or make you hesitate?"), {
    target: { value: "Needed a clearer source" },
  });
  fireEvent.change(
    screen.getByLabelText(
      "4. What would Jack need before you’d use it—or recommend it—to your crew?",
    ),
    { target: { value: "More local examples" } },
  );
}

describe("UserTestFeedback", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    toast.mockReset();
    vi.stubGlobal("fetch", vi.fn());
    Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 0 });
    window.matchMedia = vi.fn().mockReturnValue({ matches: false });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("submits feedback and then completes logout", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ id: "1" }), { status: 201 }));
    const { onContinue } = renderFeedback();
    expect(
      screen.getByRole("dialog", { name: "Before you go — how did Jack do?" }),
    ).toBeTruthy();
    fillRequiredAnswers();
    fireEvent.click(screen.getByRole("button", { name: "Submit feedback" }));
    await waitFor(() => expect(onContinue).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("Skip for now completes logout without submitting", async () => {
    const { onContinue } = renderFeedback();
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    await waitFor(() => expect(onContinue).toHaveBeenCalledOnce());
    expect(fetch).not.toHaveBeenCalled();
  });

  it("completes logout and preserves answers when the API fails", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("offline"));
    const { onContinue } = renderFeedback();
    fillRequiredAnswers();
    fireEvent.click(screen.getByRole("button", { name: "Submit feedback" }));
    await waitFor(() => expect(onContinue).toHaveBeenCalledOnce());
    expect(localStorage.getItem("jack.userTesting.feedbackDraft.v1:user_1")).toContain(
      "Find a safe procedure",
    );
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Feedback saved on this device" }),
    );
  });

  it("does not show for non-consenting or inactive users and never blocks logout", () => {
    const inactive = vi.fn();
    const ref = createRef<UserTestFeedbackHandle>();
    render(
      <UserTestFeedback
        ref={ref}
        consented={false}
        userId="user_1"
        now={() => 100_000}
        minimumSessionMs={0}
      />,
    );
    markFeedbackFeature("ask_jack", 1);
    ref.current!.request("logout", inactive);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(inactive).toHaveBeenCalledOnce();
  });

  it("supports keyboard dismissal as Skip for now", async () => {
    const { onContinue } = renderFeedback();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(onContinue).toHaveBeenCalledOnce());
  });
});
