import { describe, expect, it } from "vitest";
import {
  JACK_CORE_MEMORY,
  correctionPersistenceReply,
  isCoreIdentityQuestion,
  isExplicitCorrection,
  matchesCanonicalIdentity,
  targetsCoreIdentity,
} from "../core-memory.js";

describe("Jack Core Memory", () => {
  it("keeps the canonical identity exact and versioned", () => {
    expect(JACK_CORE_MEMORY).toEqual({
      version: 1,
      identity:
        "I'm Jack, Torch's Field Intelligence. I help crews solve problems, capture hard-earned knowledge, and pass it forward.",
    });
  });

  it.each([
    "Who are you?",
    "What are you?",
    "Who are you and what do you do?",
    "Tell me about yourself.",
    "Who is Jack?",
    "What does Jack do?",
    "Explain Jack's identity in more detail.",
    "Introduce yourself",
  ])("recognizes identity question: %s", (message) => {
    expect(isCoreIdentityQuestion(message)).toBe(true);
  });

  it("recognizes explicit Core identity correction intent", () => {
    const message = `Treat my correction as the canonical self-description. Supersede the previous wording and retain this exact statement for future conversations: "${JACK_CORE_MEMORY.identity}"`;
    expect(isExplicitCorrection(message)).toBe(true);
    expect(targetsCoreIdentity(message)).toBe(true);
    expect(matchesCanonicalIdentity(message)).toBe(true);
  });

  it.each([
    "What's the temperature correction factor for conductor ampacity?",
    "How do I apply a correction factor to voltage drop?",
    "Explain the correction procedure for TIG welding.",
  ])("does not misclassify a trade question as a correction: %s", (message) => {
    expect(isExplicitCorrection(message)).toBe(false);
  });

  it("reports persistence truthfully", () => {
    expect(
      correctionPersistenceReply({ stored: true, coreIdentity: false }),
    ).toMatch(/saved.*pending/i);
    expect(
      correctionPersistenceReply({ stored: false, coreIdentity: false }),
    ).toMatch(/couldn't store.*not treated it as retained/i);
  });
});
