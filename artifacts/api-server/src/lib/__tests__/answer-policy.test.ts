import { describe, expect, it } from "vitest";
import { sanitizeJackAnswer } from "../answer-policy.js";

describe("sanitizeJackAnswer", () => {
  it("removes the observed location reply's help offer and literal bold markers", () => {
    const raw =
      "It looks like you're in the **Living Memory** section related to **Welding Machine Parameter Setup**. This area is for accessing information or procedures about setting up welding machines. If you need explanations on specific parameters or how to set something up, which aspect you're interested in, and I can help clarify!";
    const answer = sanitizeJackAnswer(raw, "Where am I?");
    expect(answer).toContain("you're in the Living Memory");
    expect(answer).toContain("Welding Machine Parameter Setup");
    expect(answer).not.toMatch(/\*\*|If you need|I can help/);
  });

  it("does not promote uncertain location to a verified fact", () => {
    const raw =
      "It looks like you're in Library, but I don't have your current view.";
    expect(sanitizeJackAnswer(raw, "Where am I?")).toBe(raw);
  });

  it("preserves branch and selected node specificity in direct location replies", () => {
    const raw =
      "You're in Living Memory, under Jack > Welder. Welding Machine Parameter Setup is open.";
    expect(sanitizeJackAnswer(raw, "Jack, where am I?")).toBe(raw);
  });

  it("does not apply location formatting to a compound field question", () => {
    const raw =
      "Check the **root gap**. If you need a different gap, check the procedure first.";
    expect(
      sanitizeJackAnswer(raw, "Where am I, and how do I set the root gap?"),
    ).toBe(raw);
  });

  it("replaces a navigation refusal with a concrete Jack workspace move", () => {
    const raw =
      "I can't navigate to video libraries or specific sections, but I can help answer questions or provide information on welding topics. Let me know what you need.";

    const answer = sanitizeJackAnswer(raw, "retrieve from the library");

    expect(answer).toBe(
      'Open Library from Jack\'s workspace menu to choose the video or section. With a selected source, say "show me the source" to open it.',
    );
    expect(answer).not.toMatch(/let me know|i can help answer|can't navigate/i);
  });

  it.each([
    "i cant navigate to video libraries or specific sections, but i can help answer questions or provide information on welding topics. let me know what you need",
    "I’m unable to open the Library or specific sections. I can provide information about welding topics.",
    "I don't have the ability to access the video library, but I can assist you.",
    "I am not able to retrieve videos from the library. Please let me know what you need.",
  ])("repairs a navigation refusal variant: %s", (raw) => {
    expect(sanitizeJackAnswer(raw, "failed on retrieval from library")).toBe(
      'Open Library from Jack\'s workspace menu to choose the video or section. With a selected source, say "show me the source" to open it.',
    );
  });

  it.each([
    "retrieval from the video library",
    "failed on retrieval from library",
  ])("treats library retrieval wording as navigation: %s", (request) => {
    const raw =
      "I cant navigate to video libraries or specific sections, but I can help answer questions.";
    expect(sanitizeJackAnswer(raw, request)).toMatch(/^Open Library from Jack/);
  });

  it("removes office filler while preserving the useful field answer", () => {
    const answer = sanitizeJackAnswer(
      "Check the root gap and travel angle. Let me know what you need.",
    );

    expect(answer).toBe("Check the root gap and travel angle.");
  });

  it.each([
    "I can help with welding topics. Let me know what you need.",
    "I'm here and ready to help. Please let me know.",
    "I’m happy to help you. How may I assist you?",
    "I'm here to provide information on welding topics. Let me know what you need.",
    "Sure. I can help with that. Please provide more details. Feel free to ask.",
    "Certainly, I can help with that. Let me know what you need.",
  ])("removes office-intern filler: %s", (raw) => {
    expect(sanitizeJackAnswer(raw)).toBe(
      "Give me the operation, setup, and what changed.",
    );
  });

  it("does not leave an empty spoken answer after removing filler", () => {
    expect(sanitizeJackAnswer("Please let me know what you need.")).toBe(
      "Give me the operation, setup, and what changed.",
    );
  });

  it("does not rewrite a field answer that merely mentions navigation", () => {
    const raw =
      "I can't navigate the torch around that corner without changing the travel angle.";
    expect(sanitizeJackAnswer(raw, "How do I navigate this joint?")).toBe(raw);
  });

  it("does not classify a source-video content question as navigation", () => {
    const raw =
      "A source video shows the root pass at low travel speed. I can't navigate the puddle by sight alone.";
    expect(sanitizeJackAnswer(raw, "What is a source video?")).toBe(raw);
  });

  it("preserves useful content around a generic opening", () => {
    expect(
      sanitizeJackAnswer("Sure, set 90 amps and check the root gap."),
    ).toBe("set 90 amps and check the root gap.");
  });
});
